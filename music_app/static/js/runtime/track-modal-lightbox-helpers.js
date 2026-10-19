function invalidatePendingTrackModalLoad() {
  if (typeof disposeTrackModalAlbumPreferences === 'function') disposeTrackModalAlbumPreferences();
  state.ui.pendingTrackModalLoadAlbumKey = '';
  state.ui.pendingTrackModalLoadToken = Number(state.ui.pendingTrackModalLoadToken || 0) + 1;
  return state.ui.pendingTrackModalLoadToken;
}

// One retained native Album composition. The hidden modal shell stays in its
// dock; only its existing dialog moves, so all track/artwork owners remain real.
let trackModalSelectionLease = null;
let trackModalSearchPresentation = null;
function retireTrackModalSearchPresentation(reason, expected = trackModalSearchPresentation) {
  if (!expected || trackModalSearchPresentation !== expected) return;
  trackModalSearchPresentation = null;
  expected.dispose(reason);
}
let trackModalPresentationRestrictions = null;
let trackModalSourcePageOwner = null;
let artistSheetOrigin = null, artistSheetGeneration = 0, artistSheetPresenter = null;
function getTrackModalArtistSheetOrigin() {return artistSheetOrigin;}
function getTrackModalArtistSheetMarker(album) {
  const origin = artistSheetOrigin;
  if (!origin || trackModalSourcePageOwner || trackModalPresentationRestrictions?.can_open_album_page === false) return null;
  const descriptor = {kind: 'album', albumKey: String(getAlbumRequestKey(album) || ''),
    presentation: 'artist-discography-sheet', artistRef: origin.artistRef,
    parentPosition: origin.entryKey, parentViewUrl: origin.parentViewUrl};
  return origin.isRetainedCurrent(descriptor) && origin === artistSheetOrigin
    ? {presentation: descriptor.presentation, artistRef: descriptor.artistRef} : null;
}
function disposeTrackModalArtistSheet() {
  const owned = artistSheetPresenter;
  artistSheetPresenter = null;
  if (!owned) return;
  owned.observer?.disconnect(); owned.unsubscribe?.(); owned.presenter?.dispose();
  if (!artistSheetPresenter) owned.overlay.classList.remove('is-artist-discography-sheet');
}
function syncTrackModalArtistSheet(descriptor, {mobile, foreground} = {}) {
  const origin = artistSheetOrigin, generation = artistSheetGeneration;
  if (!mobile || !origin || !origin.isRetainedCurrent(descriptor)) {disposeTrackModalArtistSheet(); return;}
  const overlay = document.getElementById('track-modal');
  if (!overlay || !window.AlbumHavenBottomSheet) return;
  if (artistSheetPresenter && artistSheetPresenter.origin !== origin) disposeTrackModalArtistSheet();
  if (artistSheetOrigin !== origin || artistSheetGeneration !== generation) return;
  if (!artistSheetPresenter) {
    const panel = overlay.querySelector('[role="dialog"]');
    if (!panel) return;
    overlay.classList.add('is-artist-discography-sheet');
    const owned = {origin, overlay, presenter: null, observer: null, unsubscribe: null, foreground};
    artistSheetPresenter = owned;
    const current = () => artistSheetPresenter === owned && artistSheetGeneration === generation
      && artistSheetOrigin === origin && origin.isRetainedCurrent(mobilePageState.pages.find(page => page.kind === 'album'));
    const top = () => current() && owned.foreground && !overlay.hidden && !overlay.inert
      && getTopmostOpenModal() === overlay;
    owned.presenter = window.AlbumHavenBottomSheet.mount({overlay, panel,
      handle: overlay.querySelector('#track-modal-sheet-handle'), toggle: overlay.querySelector('#track-modal-sheet-toggle'),
      scroller: overlay.querySelector('.track-modal-body'), readBounds: () => ({header: origin.readHeader()}),
      isCurrent: current, foreground: top, requestClose: () => current() ? requestMobileArtistSheetDismissal() : false,
      backgroundNodes: [document.getElementById('shell-main-surface'), document.querySelector('.global-player')]
        .filter(node => node && !node.contains(overlay)),
    });
    if (!current()) {owned.presenter.dispose(); return;}
    owned.reconcileForeground = () => {if (current()) owned.presenter.suspend(!top());};
    owned.isCurrent = current;
    owned.unsubscribe = window.AlbumHavenArtistPageRuntime?.subscribe(() => {
      if (!current() && artistSheetPresenter === owned) {
        disposeTrackModalArtistSheet();
        if (!artistSheetPresenter) syncMobilePageShell();
      }
    });
    if (typeof MutationObserver === 'function') {
      owned.observer = new MutationObserver(() => {
        if (current()) owned.presenter.suspend(!top());
        else if (artistSheetPresenter === owned) {
          disposeTrackModalArtistSheet();
          if (!artistSheetPresenter) syncMobilePageShell();
        }
      });
      owned.observer.observe(document.body, {subtree: true, attributes: true, attributeFilter: ['hidden', 'inert']});
    }
  }
  if (!artistSheetPresenter || artistSheetOrigin !== origin || artistSheetGeneration !== generation) return;
  artistSheetPresenter.foreground = foreground;
  artistSheetPresenter.presenter.suspend(!foreground, {releaseBackground: !foreground});
  artistSheetPresenter.presenter.update();
}
function resumeTrackModalArtistSheetForFocus(target) {
  const owned = artistSheetPresenter;
  if (!owned || !owned.overlay.contains(target)) return true;
  owned.reconcileForeground?.();
  return artistSheetPresenter === owned && owned.isCurrent?.() === true
    && getTopmostOpenModal() === owned.overlay && !target.closest('[hidden],[inert]');
}
function updateTrackModalArtistSheet() {
  if (typeof mobilePageState !== 'undefined') syncTrackModalArtistSheet(mobilePageState.pages.find(page => page.kind === 'album'),
    {mobile: usesMobilePageLayout(), foreground: mobilePageState.pages.at(-1)?.kind === 'album'});
}
let trackModalSourcePageSequence = 0;
const trackModalSourcePageOwners = new Map();
const TRACK_MODAL_SOURCE_PAGE_LIMIT = 20;
let trackModalSourcePageReplay = null;
function getTrackModalSourcePageOwner() {return trackModalSourcePageOwner;}
function getTrackModalSourcePageToken() {return trackModalSourcePageOwner?.token || null;}
function isTrackModalSourceActionCurrent() {
  const owner = trackModalSourcePageOwner;
  if (!owner) return true;
  try {return owner.isCurrent() === true && trackModalSourcePageOwner === owner;} catch {return false;}
}
function isTrackModalSourcePageCurrent(token, albumKey) {
  const owner = trackModalSourcePageOwner;
  if (!owner || !token || owner.token !== token) return false;
  const album = getCurrentTrackModalAlbum();
  if (!album) return false;
  try {return String(getAlbumRequestKey(album) || '') === String(albumKey || '') && isTrackModalSourceActionCurrent();} catch {return false;}
}
function resolveTrackModalSourcePageOwner(candidate, albumKey, restrictions) {
  if (!candidate) return null;
  if (candidate.token && trackModalSourcePageOwners.get(candidate.token) === candidate) return candidate;
  if (typeof candidate.isCurrent !== 'function') return null;
  return Object.freeze({token: `album-source-${Date.now().toString(36)}-${++trackModalSourcePageSequence}-${Math.random().toString(36).slice(2)}`,
    albumKey, restrictions, isCurrent: candidate.isCurrent, revalidate: candidate.revalidate});
}
function retainTrackModalSourcePageOwner(owner) {
  if (!owner) return;
  trackModalSourcePageOwners.delete(owner.token); trackModalSourcePageOwners.set(owner.token, owner);
  while (trackModalSourcePageOwners.size > TRACK_MODAL_SOURCE_PAGE_LIMIT) {
    trackModalSourcePageOwners.delete(trackModalSourcePageOwners.keys().next().value);
  }
}
async function restoreTrackModalSourcePage(descriptor, {signal, isCurrent, present} = {}) {
  const owner = trackModalSourcePageOwners.get(descriptor?.sourcePageToken);
  if (!owner || owner.albumKey !== descriptor.albumKey || typeof owner.revalidate !== 'function') return false;
  const pending = {}; trackModalSourcePageReplay = pending;
  releaseTrackModalSelection('history');
  const token = Number(state.ui?.pendingTrackModalLoadToken || 0);
  let presentationAttempt = null, completed = false;
  try {
    const result = await owner.revalidate({signal, albumKey: descriptor.albumKey});
    presentationAttempt = result?.presentationAttempt || null;
    if (signal?.aborted || !isCurrent?.()) return false;
    if (trackModalSourcePageReplay !== pending || token !== Number(state.ui?.pendingTrackModalLoadToken || 0)) {
      throw Object.assign(new Error('A newer native Album action owns this presentation.'), {name: 'AbortError', sourcePageSuperseded: true});
    }
    if (!result?.album || String(getAlbumRequestKey(result.album) || '') !== descriptor.albumKey
      || typeof result.isCurrent !== 'function' || !result.isCurrent()) return false;
    const fresh = normalizeTrackModalPresentationRestrictions(result.presentationRestrictions);
    const restrictions = normalizeTrackModalPresentationRestrictions({
      can_view_artwork: owner.restrictions.can_view_artwork && fresh.can_view_artwork,
      can_play_album: owner.restrictions.can_play_album && fresh.can_play_album,
      can_open_album_page: owner.restrictions.can_open_album_page && fresh.can_open_album_page,
    });
    if (!restrictions.can_open_album_page) return false;
    const refreshed = Object.freeze({...owner, restrictions, isCurrent: result.isCurrent});
    retainTrackModalSourcePageOwner(refreshed);
    let invoked = false;
    const open = () => {
      if (invoked || signal?.aborted || !isCurrent?.() || presentationAttempt && !presentationAttempt.isCurrent()) return false;
      invoked = true;
      return openTrackModal(result.album, {sourcePageOwner: refreshed, presentationRestrictions: restrictions,
        searchPresentationAttempt: presentationAttempt, coverLightboxGallery: false});
    };
    const presented = typeof present === 'function' ? await present(open) : open();
    completed = invoked && presented !== false && (!presentationAttempt || presentationAttempt.isCommitted());
    return completed;
  } finally {
    if (trackModalSourcePageReplay === pending) trackModalSourcePageReplay = null;
    if (!completed) {
      retireTrackModalSearchPresentation('replay-uncommitted', presentationAttempt);
      presentationAttempt?.dispose('replay-uncommitted');
    }
  }
}

function normalizeTrackModalPresentationRestrictions(value) {
  const denied = name => value && Object.prototype.hasOwnProperty.call(value, name) && value[name] === false;
  return Object.freeze({can_view_artwork: !denied('can_view_artwork'), can_play_album: !denied('can_play_album'),
    can_open_album_page: !denied('can_open_album_page')});
}
function getTrackModalPresentationRestrictions() {return trackModalPresentationRestrictions;}
function canViewTrackModalArtwork() {
  const lease = trackModalSelectionLease;
  return lease ? lease.isCurrent() && lease.canArtwork()
    : isTrackModalSourceActionCurrent() && trackModalPresentationRestrictions?.can_view_artwork !== false;
}

function getTrackModalSelectionLease() { return trackModalSelectionLease; }
function getTrackModalContentRoot() {
  return trackModalSelectionLease?.dialog || document.getElementById('track-modal');
}
function isTrackModalContentVisible() {
  const lease = trackModalSelectionLease;
  return lease ? lease.dialog.isConnected && lease.isCurrent() : !document.getElementById('track-modal')?.hidden;
}
function getTrackModalSelectionAlbumFor(element) {
  const lease = trackModalSelectionLease;
  return lease && lease.dialog.contains(element) && lease.isCurrent() ? lease.album : null;
}
function canPlayTrackModalSelection(element) {
  const lease = trackModalSelectionLease;
  if (element?.closest?.('[data-resource-selection-content]')) {
    return !!(lease && lease.dialog.contains(element) && lease.isCurrent() && lease.canPlay());
  }
  return !element?.closest?.('#track-modal')
    || isTrackModalSourceActionCurrent() && trackModalPresentationRestrictions?.can_play_album !== false;
}
function reconcileTrackModalSelectionAlbum(album) {
  const lease = trackModalSelectionLease;
  if (!lease) return;
  if (!lease.isCurrent() || getAlbumRequestKey(album) !== getAlbumRequestKey(lease.album)) lease.release('content');
  else lease.album = album;
}
function focusTrackModalSelectionTitle(lease, title) {
  const button = title?.querySelector('[data-resource-selection-open]');
  if (button) {button.focus({preventScroll: true}); return;}
  if (!title) return;
  lease.focusedHeading = {node: title, tabIndex: title.getAttribute('tabindex')};
  title.setAttribute('tabindex', '-1'); title.focus({preventScroll: true});
}
function restoreTrackModalSelectionHeading(lease) {
  const saved = lease.focusedHeading;
  if (!saved) return;
  if (saved.tabIndex === null) saved.node.removeAttribute('tabindex');
  else saved.node.setAttribute('tabindex', saved.tabIndex);
  lease.focusedHeading = null;
}
function decorateTrackModalSelection() {
  const lease = trackModalSelectionLease;
  if (!lease) {
    if (!isTrackModalSourceActionCurrent() || trackModalPresentationRestrictions?.can_play_album === false) {
      for (const button of document.getElementById('track-modal')?.querySelectorAll?.('.play-track-button') || []) button.disabled = true;
    }
    return;
  }
  if (!lease.isCurrent()) return;
  const title = lease.dialog.querySelector('.album-details-header__primary');
  const oldTitle = title?.querySelector('[data-resource-selection-open]');
  const canOpen = lease.canOpen() && typeof lease.onOpen === 'function';
  if (title && canOpen && !oldTitle) {
    const restoreFocus = document.activeElement === title;
    restoreTrackModalSelectionHeading(lease);
    title.innerHTML = ButtonComponent.renderButton({label: title.textContent, variant: 'secondary', quiet: true, size: 'small',
      attributes: {'data-resource-selection-open': '1'}});
    const button = title.querySelector('button'); button?.addEventListener('click', lease.onOpen);
    if (restoreFocus) button?.focus({preventScroll: true});
  } else if (title && !canOpen && oldTitle) {
    const restoreFocus = oldTitle === document.activeElement || oldTitle.contains(document.activeElement);
    title.textContent = oldTitle.textContent;
    if (restoreFocus) focusTrackModalSelectionTitle(lease, title);
  }
  const actions = lease.dialog.querySelector('.album-details-header__actions');
  const oldPage = actions?.querySelector('[data-resource-selection-page]');
  const canPage = lease.canPage() && typeof lease.onPage === 'function';
  if (actions && canPage && !oldPage) {
    const host = document.createElement('span');
    host.innerHTML = ButtonComponent.renderActionButton({icon: 'expand', ariaLabel: 'Full size', title: 'Full size', presentation: 'bare',
      attributes: {'data-resource-selection-page': '1'}});
    const button = host.firstElementChild;
    actions.prepend(button); button.addEventListener('click', lease.onPage);
  } else if (!canPage && oldPage) {
    const restoreFocus = oldPage === document.activeElement || oldPage.contains(document.activeElement);
    oldPage.remove();
    if (restoreFocus) focusTrackModalSelectionTitle(lease, title);
  }
  for (const button of lease.dialog.querySelectorAll('.play-track-button')) if (!lease.canPlay()) button.disabled = true;
  for (const button of lease.dialog.querySelectorAll('[data-open-lightbox]')) if (!lease.canArtwork()) button.disabled = true;
}
function releaseTrackModalSelection(reason = 'release') { trackModalSelectionLease?.release(reason); }
function acquireTrackModalSelection(host, album, {isCurrent = () => false, canPlay = () => false, canArtwork = () => false, canOpen = () => true, canPage = () => false, retainNavigation, onRelease, onOpen, onPage, searchPresentationAttempt = null} = {}) {
  const overlay = document.getElementById('track-modal');
  if (trackModalSourcePageReplay || !host?.isConnected || !overlay?.hidden || !album || albumRequiresHydration(album) || !isCurrent()
    || searchPresentationAttempt && !searchPresentationAttempt.isCurrent()) return null;
  releaseTrackModalSelection('replace');
  retireTrackModalSearchPresentation('embed-replace');
  const dialog = overlay.querySelector('.track-modal-dialog');
  if (!dialog || !overlay.hidden || trackModalSelectionLease || !isCurrent()
    || searchPresentationAttempt && !searchPresentationAttempt.isCurrent()) return null;
  trackModalCleanupGeneration += 1;
  trackModalSourcePageOwner = null;
  const marker = document.createComment('Native Album selection dock');
  dialog.before(marker);
  const attributes = ['role', 'aria-modal', 'aria-label'].map(name => [name, dialog.getAttribute(name)]);
  const previousGallery = state.ui.trackModalCoverLightboxGallery;
  const token = invalidatePendingTrackModalLoad();
  const lease = {dialog, album, token, isCurrent, canPlay, canArtwork, canOpen, canPage, retainNavigation, onOpen, onPage, release(reason) {
    if (trackModalSelectionLease !== lease) return;
    trackModalSelectionLease = null;
    window.removeEventListener('resize', resize);
    restoreTrackModalSelectionHeading(lease);
    const ownsContent = Number(state.ui.pendingTrackModalLoadToken || 0) === token
      && state.modalReleases?.[state.modalReleaseIndex] === lease.album;
    if (marker.parentNode) marker.replaceWith(dialog);
    for (const [name, value] of attributes) {if (value === null) dialog.removeAttribute(name); else dialog.setAttribute(name, value);}
    dialog.removeAttribute('data-resource-selection-content');
    if (ownsContent) {
      invalidatePendingTrackModalLoad(); state.modalReleases = []; state.modalReleaseIndex = 0;
      state.ui.trackModalCoverLightboxGallery = previousGallery;
      clearTrackModalRenderedState();
    }
    searchPresentationAttempt?.dispose(reason);
    onRelease?.(reason);
  }};
  const resize = () => {
    if (trackModalSelectionLease !== lease) return;
    if (!lease.isCurrent()) {lease.release('stale'); return;}
    decorateTrackModalSelection();
  };
  trackModalSelectionLease = lease;
  dialog.setAttribute('role', 'region'); dialog.removeAttribute('aria-modal');
  dialog.setAttribute('aria-label', 'Album details'); dialog.setAttribute('data-resource-selection-content', 'album');
  host.appendChild(dialog);
  state.modalReleases = [album]; state.modalReleaseIndex = 0;
  state.ui.trackModalCoverLightboxGallery = false;
  try {
    renderTrackModalRelease(album);
    if (!isCurrent() || trackModalSelectionLease !== lease || searchPresentationAttempt && !searchPresentationAttempt.isCurrent()) {lease.release('stale'); return null;}
    decorateTrackModalSelection();
    if (!isCurrent() || trackModalSelectionLease !== lease) {lease.release('stale'); return null;}
    if (searchPresentationAttempt && (!dialog.querySelector('#track-modal-list') || !host.contains(dialog)
      || !searchPresentationAttempt.isCurrent())) {lease.release('missing-render'); return null;}
    window.addEventListener('resize', resize);
    return lease;
  } catch (error) {lease.release('error'); throw error;}
}

const trackModalAlbumDetailsLoads = new Map();
const trackModalSpeculativeAlbumDetailsLoadControllers = new Map();
const trackModalHydratedAlbumDetails = new Map();
const trackModalHydratedAlbumDetailsLru = new Map();
const TRACK_MODAL_HYDRATED_ALBUM_DETAILS_LIMIT = 10;
const TRACK_MODAL_SPECULATIVE_PREWARM_LIMIT = 2;
let trackModalActiveSpeculativePrewarms = 0;
let trackModalCleanupGeneration = 0;
const trackModalSpeculativePrewarmControllers = new Set();
const trackModalCoverLoadSuspensionTokens = new Set();

function albumRequiresHydration(album) {
  if (!album || typeof album !== 'object') return false;
  if (album.preview_only === true) return true;
  const tracks = Array.isArray(album.tracks) ? album.tracks : [];
  const declaredTrackCounts = [album.track_count_preview, album.track_count]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return declaredTrackCounts.length > 0 && !declaredTrackCounts.includes(tracks.length);
}

function renderTrackModalLoadingState(album) {
  const els = getTrackModalElements();
  if (!els.overlay || !album) return;
  const headerParts = [album.album_artist || '', album.name || 'Album', album.year || ''].filter(Boolean);
  els.title.textContent = headerParts.join(' - ');
  els.subtitle.textContent = 'Loading album details...';
  if (els.folder) {
    els.folder.dataset.album = '';
    els.folder.dataset.albumKey = String(getAlbumRequestKey(album) || getAlbumIdentity(album) || album?.key || '');
  }
  if (els.editTags) {
    els.editTags.dataset.album = '';
    els.editTags.dataset.albumKey = String(getAlbumRequestKey(album) || getAlbumIdentity(album) || album?.key || '');
  }
  els.cover.innerHTML = `
    <div class="track-modal-cover-shell">
      ${buildAlbumArtboxHtml({ state: 'loading', label: 'Loading cover art' })}
    </div>
  `;
  if (els.missingWarning) {
    els.missingWarning.hidden = true;
    els.missingWarning.innerHTML = '';
  }
  if (els.duplicateWarning) {
    els.duplicateWarning.hidden = true;
    els.duplicateWarning.innerHTML = '';
  }
  if (els.duplicateTabs) {
    els.duplicateTabs.hidden = true;
    els.duplicateTabs.innerHTML = '';
  }
  els.list.innerHTML = '<li class="track-modal-loading-row">Loading album details...</li>';
  if (els.footer) {
    els.footer.hidden = true;
    els.footer.textContent = '';
  }
}

function clearTrackModalRenderedState() {
  if (typeof disposeTrackModalAlbumPreferences === 'function') disposeTrackModalAlbumPreferences();
  if (typeof NativePlaytables !== 'undefined') NativePlaytables.retire('album-tracks');
  const els = getTrackModalElements();
  if (!els.overlay) return;
  if (els.title) {
    els.title.textContent = '';
  }
  if (els.subtitle) {
    els.subtitle.textContent = '';
  }
  if (els.cover) {
    els.cover.innerHTML = '';
  }
  if (els.missingWarning) {
    els.missingWarning.hidden = true;
    els.missingWarning.innerHTML = '';
  }
  if (els.duplicateWarning) {
    els.duplicateWarning.hidden = true;
    els.duplicateWarning.innerHTML = '';
  }
  if (els.duplicateTabs) {
    els.duplicateTabs.hidden = true;
    els.duplicateTabs.innerHTML = '';
  }
  if (els.list) {
    els.list.innerHTML = '';
  }
  if (els.footer) {
    els.footer.hidden = true;
    els.footer.textContent = '';
  }
  if (els.tabs) {
    els.tabs.hidden = true;
    els.tabs.innerHTML = '';
  }
  if (els.folder?.dataset) {
    els.folder.dataset.album = '';
    els.folder.dataset.albumKey = '';
  }
  if (els.editTags?.dataset) {
    els.editTags.dataset.album = '';
    els.editTags.dataset.albumKey = '';
  }
}

function scheduleTrackModalCleanupAfterPaint(generation, coverLoadSuspensionTokens = []) {
  const cleanup = () => {
    coverLoadSuspensionTokens.forEach((token) => resumeGalleryCoverLoadToken(token));
    if (generation !== trackModalCleanupGeneration) return;
    const els = getTrackModalElements();
    if (!els.overlay?.hidden) return;
    clearTrackModalRenderedState();
    if (typeof compactCurrentViewForIdle === 'function') {
      compactCurrentViewForIdle();
    }
  };
  if (typeof scheduleBrowserAnimationFrame !== 'function') {
    cleanup();
    return;
  }
  scheduleBrowserAnimationFrame(() => scheduleBrowserAnimationFrame(cleanup));
}

function openTrackModalShell(album, releaseSet = getAlbumReleaseSet(album)) {
  releaseTrackModalSelection('modal');
  if (trackModalPresentationRestrictions?.can_open_album_page !== false
    && typeof presentMobileAlbumPage === 'function') presentMobileAlbumPage(album);
  const els = getTrackModalElements();
  if (!els.overlay || !album) return;
  state.modalReleases = Array.isArray(releaseSet?.releases) && releaseSet.releases.length
    ? releaseSet.releases
    : [album];
  state.modalReleaseIndex = Number.isInteger(releaseSet?.selectedIndex)
    ? Math.max(0, Math.min(releaseSet.selectedIndex, state.modalReleases.length - 1))
    : 0;
  hideVersionContextMenu();
  renderTrackModalLoadingState(album);
  if (typeof renderTrackModalTabs === 'function') renderTrackModalTabs(els);
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  updateTrackModalArtistSheet();
}

function suspendGalleryCoverLoadsForTrackModal() {
  if (
    typeof virtualGrid !== 'undefined'
    && virtualGrid
    && typeof virtualGrid.suspendSelectedArtistCoverLoadsForUserAction === 'function'
  ) {
    const token = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
    if (token) trackModalCoverLoadSuspensionTokens.add(token);
    return token;
  }
  return 0;
}

function resumeGalleryCoverLoadsAfterTrackModalAction(token = 0) {
  const normalizedToken = Number(token);
  if (!normalizedToken || !trackModalCoverLoadSuspensionTokens.delete(normalizedToken)) return false;
  return resumeGalleryCoverLoadToken(normalizedToken);
}

function resumeGalleryCoverLoadToken(token = 0) {
  const normalizedToken = Number(token);
  if (!normalizedToken) return false;
  if (
    typeof virtualGrid !== 'undefined'
    && virtualGrid
    && typeof virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction === 'function'
  ) {
    return virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(normalizedToken);
  }
  return false;
}

function takeAllGalleryCoverLoadSuspensionTokens() {
  const tokens = Array.from(trackModalCoverLoadSuspensionTokens);
  tokens.forEach((token) => trackModalCoverLoadSuspensionTokens.delete(token));
  return tokens;
}

function getTrackModalAlbumVersionKey(album) {
  if (!album) return '';
  const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();
  return JSON.stringify([
    normalize(getAlbumRequestKey(album) || getAlbumIdentity(album)),
    normalize(album.album_artist || album.artist),
    normalize(album.name || album.album),
    normalize(album.year),
    normalize(album.edition),
  ]);
}

function cacheHydratedTrackModalAlbum(albumKey, album, options = {}) {
  if (!album) return;
  const requestedKey = String(albumKey || '').trim();
  const resolvedAlbum = attachGalleryPlaybackContextToAlbum(album);
  const liveAliases = getTrackModalAlbumKeyAliases(requestedKey, resolvedAlbum);
  const aliases = Array.from(new Set([
    ...liveAliases,
    ...Array.from(options.aliases || [], (alias) => String(alias || '').trim()),
  ].filter(Boolean)));
  const trustedAliases = new Set(
    Array.from(options.aliases || [], (alias) => String(alias || '').trim()).filter(Boolean),
  );
  const replacedAlbums = new Set(
    aliases.map((alias) => trackModalHydratedAlbumDetails.get(alias)).filter(Boolean),
  );
  const previewAlbumsByAlias = new Map();
  aliases.forEach((alias) => {
    const indexedAlbum = state?.gallery?.albumIndex instanceof Map
      ? state.gallery.albumIndex.get(alias)
      : null;
    if (albumRequiresHydration(indexedAlbum)) previewAlbumsByAlias.set(alias, indexedAlbum);
  });
  replacedAlbums.forEach((replacedAlbum) => {
    const replacedEntry = trackModalHydratedAlbumDetailsLru.get(replacedAlbum);
    replacedEntry?.previewAlbumsByAlias?.forEach((previewAlbum, alias) => {
      if (!previewAlbumsByAlias.has(alias)) previewAlbumsByAlias.set(alias, previewAlbum);
    });
  });
  aliases.forEach((alias) => {
    trackModalHydratedAlbumDetails.set(alias, resolvedAlbum);
  });
  liveAliases.forEach((alias) => {
    if (state?.gallery?.albumIndex instanceof Map) {
      state.gallery.albumIndex.set(alias, resolvedAlbum);
    }
  });
  replacedAlbums.forEach((replacedAlbum) => {
    if (replacedAlbum === resolvedAlbum) return;
    const remainsCached = Array.from(trackModalHydratedAlbumDetails.values())
      .some((cachedAlbum) => cachedAlbum === replacedAlbum);
    if (!remainsCached) trackModalHydratedAlbumDetailsLru.delete(replacedAlbum);
  });
  trackModalHydratedAlbumDetailsLru.delete(resolvedAlbum);
  trackModalHydratedAlbumDetailsLru.set(
    resolvedAlbum,
    {
      aliases,
      previewAlbumsByAlias,
      trustedAliases,
      inventoryMutationRevision: Number(state?.status?.inventory_mutation_revision || 0),
      tagEditMutationClaim: options.tagEditMutationClaim || null,
    },
  );
  while (trackModalHydratedAlbumDetailsLru.size > TRACK_MODAL_HYDRATED_ALBUM_DETAILS_LIMIT) {
    const oldestAlbum = trackModalHydratedAlbumDetailsLru.keys().next().value;
    const oldestEntry = trackModalHydratedAlbumDetailsLru.get(oldestAlbum);
    trackModalHydratedAlbumDetailsLru.delete(oldestAlbum);
    trackModalHydratedAlbumDetails.forEach((cachedAlbum, alias) => {
      if (cachedAlbum === oldestAlbum) trackModalHydratedAlbumDetails.delete(alias);
    });
    if (state?.gallery?.albumIndex instanceof Map) {
      (oldestEntry?.aliases || []).forEach((alias) => {
        if (state.gallery.albumIndex.get(alias) !== oldestAlbum) return;
        const previewAlbum = oldestEntry.previewAlbumsByAlias.get(alias);
        if (previewAlbum) {
          state.gallery.albumIndex.set(alias, previewAlbum);
        } else {
          state.gallery.albumIndex.delete(alias);
        }
      });
    }
  }
}

function invalidateHydratedTrackModalAlbumDetails(albums) {
  const candidates = Array.isArray(albums) ? albums.filter(Boolean) : [];
  if (!candidates.length) return 0;
  const targetAliases = new Set();
  candidates.forEach((album) => {
    getTrackModalAlbumKeyAliases(getAlbumRequestKey(album), album).forEach((alias) => {
      targetAliases.add(alias);
    });
  });
  const invalidatedAlbums = new Set(
    Array.from(targetAliases, (alias) => trackModalHydratedAlbumDetails.get(alias))
      .filter(Boolean),
  );
  invalidatedAlbums.forEach((cachedAlbum) => {
    const cachedEntry = trackModalHydratedAlbumDetailsLru.get(cachedAlbum);
    trackModalHydratedAlbumDetails.forEach((mappedAlbum, alias) => {
      if (mappedAlbum === cachedAlbum) trackModalHydratedAlbumDetails.delete(alias);
    });
    if (state?.gallery?.albumIndex instanceof Map) {
      (cachedEntry?.aliases || []).forEach((alias) => {
        if (state.gallery.albumIndex.get(alias) !== cachedAlbum) return;
        const previewAlbum = cachedEntry.previewAlbumsByAlias.get(alias);
        if (previewAlbum) state.gallery.albumIndex.set(alias, previewAlbum);
        else state.gallery.albumIndex.delete(alias);
      });
    }
    trackModalHydratedAlbumDetailsLru.delete(cachedAlbum);
  });
  return invalidatedAlbums.size;
}

function invalidateAllHydratedTrackModalAlbumDetails() {
  const cachedAlbums = Array.from(trackModalHydratedAlbumDetailsLru.keys()).filter((album) => {
    const claim = trackModalHydratedAlbumDetailsLru.get(album)?.tagEditMutationClaim;
    return !(claim
      && typeof tagEditViewMutationStillOwnsResources === 'function'
      && tagEditViewMutationStillOwnsResources(claim));
  });
  if (!cachedAlbums.length) return 0;
  return invalidateHydratedTrackModalAlbumDetails(cachedAlbums);
}

function getTrackModalAlbumKeyAliases(albumKey, album = null) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  const indexedAlbum = album || getIndexedAlbum(normalizedAlbumKey);
  return Array.from(new Set([
    normalizedAlbumKey,
    String(getAlbumRequestKey(indexedAlbum) || '').trim(),
    String(getAlbumIdentity(indexedAlbum) || '').trim(),
    getTrackModalAlbumVersionKey(indexedAlbum),
  ].filter(Boolean)));
}

function trackModalAlbumsShareLogicalRelease(leftAlbum, rightAlbum) {
  if (!leftAlbum || !rightAlbum) return false;
  const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();
  return normalize(leftAlbum.album_artist || leftAlbum.artist)
      === normalize(rightAlbum.album_artist || rightAlbum.artist)
    && normalize(leftAlbum.name || leftAlbum.album)
      === normalize(rightAlbum.name || rightAlbum.album)
    && normalize(leftAlbum.year) === normalize(rightAlbum.year)
    && normalize(leftAlbum.edition) === normalize(rightAlbum.edition);
}

function trackModalAlbumsHaveCompatibleMembership(indexedAlbum, cachedAlbum) {
  if (!indexedAlbum || !cachedAlbum) return true;
  const cachedTracks = Array.isArray(cachedAlbum.tracks) ? cachedAlbum.tracks : [];
  if (albumRequiresHydration(indexedAlbum)) {
    const declaredTrackCounts = [indexedAlbum.track_count_preview, indexedAlbum.track_count]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
    return !declaredTrackCounts.length || declaredTrackCounts.includes(cachedTracks.length);
  }
  if (!Array.isArray(indexedAlbum.tracks)) return true;
  const trackPaths = (tracks) => new Set(
    tracks.map((track) => String(track?.path || '').trim()).filter(Boolean),
  );
  const indexedPaths = trackPaths(indexedAlbum.tracks);
  const cachedPaths = trackPaths(cachedTracks);
  return indexedPaths.size === cachedPaths.size
    && Array.from(indexedPaths).every((path) => cachedPaths.has(path));
}

function getCachedHydratedTrackModalAlbum(albumKey) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return null;
  const cachedAlbum = trackModalHydratedAlbumDetails.get(normalizedAlbumKey);
  if (cachedAlbum && !albumRequiresHydration(cachedAlbum)) {
    const indexedAlbum = getIndexedAlbum(normalizedAlbumKey);
    const cachedEntry = trackModalHydratedAlbumDetailsLru.get(cachedAlbum);
    const cachedInventoryRevision = Number(cachedEntry?.inventoryMutationRevision || 0);
    const currentInventoryRevision = Number(state?.status?.inventory_mutation_revision || 0);
    const pendingMutationOwnsCachedMembership = Boolean(
      cachedEntry?.tagEditMutationClaim
      && typeof tagEditViewMutationStillOwnsResources === 'function'
      && tagEditViewMutationStillOwnsResources(cachedEntry.tagEditMutationClaim)
    );
    if (
      cachedInventoryRevision !== currentInventoryRevision
      && !pendingMutationOwnsCachedMembership
    ) {
      invalidateHydratedTrackModalAlbumDetails([cachedAlbum]);
      return null;
    }
    const trustedAlias = cachedEntry?.trustedAliases?.has(normalizedAlbumKey);
    if (
      indexedAlbum
      && (
        !trackModalAlbumsShareLogicalRelease(indexedAlbum, cachedAlbum)
        || (!trustedAlias && !trackModalAlbumsHaveCompatibleMembership(indexedAlbum, cachedAlbum))
      )
    ) {
      return null;
    }
    trackModalHydratedAlbumDetailsLru.delete(cachedAlbum);
    trackModalHydratedAlbumDetailsLru.set(cachedAlbum, cachedEntry);
    return cachedAlbum;
  }
  return null;
}

function resolveGalleryPlaybackContext(playbackContext) {
  if (!playbackContext || typeof playbackContext !== 'object') return null;
  return playbackContext;
}

function resolveAlbumPlaybackContextFromView(album) {
  const playbackContext = state?.view?.playback_context;
  if (!playbackContext || typeof playbackContext !== 'object') return null;
  const albumRef = String(getAlbumIdentity(album) || album?.key || '').trim();
  if (!albumRef) return null;
  const orderedAlbumRefs = Array.isArray(playbackContext.ordered_album_refs)
    ? playbackContext.ordered_album_refs.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!orderedAlbumRefs.includes(albumRef)) return null;
  return resolveGalleryPlaybackContext(playbackContext);
}

function attachGalleryPlaybackContextToAlbum(album) {
  if (!album || typeof album !== 'object') return album;
  const playbackContext = resolveGalleryPlaybackContext(album.playback_context)
    || resolveAlbumPlaybackContextFromView(album);
  if (!playbackContext) return album;
  const copy = {
    ...album,
    playback_context: playbackContext,
  };
  if (typeof SearchAlbumPresentationProvenance !== 'undefined') SearchAlbumPresentationProvenance.bridge(album, copy);
  return copy;
}

// Exact response objects carry provenance. Caches, renderers and subject copies
// cannot turn DTO fields into a fresh preference read or revive an older grant.
const trackModalPreferenceReceipts = new WeakMap();
const trackModalPreferenceSources = new Map(), trackModalPreferenceListeners = new Set();
let trackModalPreferenceScope = null;
function subscribeTrackModalPreferences(listener) {
  trackModalPreferenceListeners.add(listener);
  return () => trackModalPreferenceListeners.delete(listener);
}
function notifyTrackModalPreferences() {
  for (const listener of [...trackModalPreferenceListeners]) {
    try {listener();} catch { /* A display subscriber cannot undo revocation. */ }
  }
}
function trimTrackModalPreferenceSources() {
  let unretained = [...trackModalPreferenceSources.values()].filter(token => token.retained === 0).length;
  let changed = false;
  for (const [key, token] of trackModalPreferenceSources) {
    if (unretained <= TRACK_MODAL_HYDRATED_ALBUM_DETAILS_LIMIT) break;
    if (token.retained !== 0) continue;
    token.revoked = true; trackModalPreferenceSources.delete(key); unretained--; changed = true;
  }
  if (changed) notifyTrackModalPreferences();
}
function retainTrackModalPreferenceRows(rows) {
  const tokens = new Set((rows || []).filter(row => getTrackModalPreferenceSource(row))
    .map(row => trackModalPreferenceReceipts.get(row).request));
  for (const token of tokens) token.retained++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const token of tokens) token.retained--;
    trimTrackModalPreferenceSources();
  };
}
function trackModalPreferenceContainerReadable(value) {
  return Boolean(value && typeof value === 'object' && !value.read_only_subject
    && value.source_readable !== false && value.readable !== false
    && (!Object.hasOwn(value.allowed_actions || {}, 'can_read') || value.allowed_actions.can_read === true));
}
function trackModalPreferenceFacts(row) {
  if (!trackModalPreferenceContainerReadable(row) || row.track_preference_state !== 'available') return null;
  const track = typeof row.track_ref === 'string' ? row.track_ref : row.path;
  const canonical = row.canonical_track_ref, inventory = row.inventory_track_ref;
  const overlay = TrackActionsRuntime.overlay(row.track_preference);
  if (typeof track !== 'string' || !track.trim() || typeof canonical !== 'string' || !canonical.trim()
    || typeof inventory !== 'string' || !/^inventory-track:[1-9]\d*:[1-9]\d*$/.test(inventory) || !overlay) return null;
  return {track_ref: track.trim(), canonical_track_ref: canonical, inventory_track_ref: inventory, track_preference: overlay};
}
function getTrackModalPreferenceSource(row) {
  const receipt = row && trackModalPreferenceReceipts.get(row);
  if (!receipt || receipt.request.revoked || receipt.scope !== TrackActionsRuntime.scope().token
    || receipt.inventoryRevision !== Number(state?.status?.inventory_mutation_revision || 0)) return null;
  const facts = trackModalPreferenceFacts(row);
  return facts && JSON.stringify(facts) === receipt.signature ? receipt.source : null;
}

// Capture only at a genuine read dispatch. Album and Loose share this bounded
// exact-object owner, but a denial never crosses their source namespaces.
function captureTrackModalPreferenceRead(namespace, sourceKey, options = {}) {
  const preferenceRuntime = typeof TrackActionsRuntime !== 'undefined' ? TrackActionsRuntime : null;
  const scope = preferenceRuntime?.scope(), epoch = preferenceRuntime?.readEpoch();
  const inventoryRevision = Number(state?.status?.inventory_mutation_revision || 0);
  if (scope?.token !== trackModalPreferenceScope) {
    trackModalPreferenceScope = scope?.token; trackModalPreferenceSources.clear();
  }
  const key = JSON.stringify([namespace, sourceKey]);
  let requestReceipt = trackModalPreferenceSources.get(key);
  if (preferenceRuntime && options.readOnlySubject !== true && options.admitPreferences !== false) {
    if (!requestReceipt || requestReceipt.revoked) requestReceipt = {revoked: false, retained: 0};
    trackModalPreferenceSources.delete(key);
    trackModalPreferenceSources.set(key, requestReceipt);
    trimTrackModalPreferenceSources();
  }
  const requestCurrent = () => {
    try {return Boolean(preferenceRuntime && !options.signal?.aborted && scope.token === preferenceRuntime.scope().token
      && inventoryRevision === Number(state?.status?.inventory_mutation_revision || 0)
      && (options.isCurrent === undefined || typeof options.isCurrent === 'function' && options.isCurrent() === true));}
    catch {return false;}
  };
  const revoke = () => {
    if (options.readOnlySubject === true || options.admitPreferences === false
      || !requestCurrent() || !requestReceipt || requestReceipt.revoked) return;
    requestReceipt.revoked = true;
    notifyTrackModalPreferences();
  };
  let admitted = false;
  return Object.freeze({revoke, admit(rows) {
    if (admitted || options.readOnlySubject === true || options.admitPreferences === false
      || !requestReceipt || requestReceipt.revoked || !requestCurrent()) return;
    admitted = true;
    // A successful current Loose replacement retires its prior exact-object
    // lineage, including rows now unavailable or absent from the population.
    // A stale preference epoch cannot retire it.
    // Fresh readable siblings still use this dispatch's original batch epoch.
    const previousReceipt = requestReceipt;
    const replacementReceipt = namespace === 'loose' && epoch === preferenceRuntime.readEpoch()
      ? {revoked: false, retained: 0} : null;
    const batch = preferenceRuntime.readBatch(epoch), seen = new Set();
    for (const row of rows) {
      if (!requestCurrent() || previousReceipt.revoked) break;
      if (!row || typeof row !== 'object' || seen.has(row)) continue;
      seen.add(row);
      const source = trackModalPreferenceFacts(row);
      if (!source || source.inventory_track_ref.split(':')[1] !== scope.library || !batch.accept(source)) continue;
      if (!requestCurrent() || previousReceipt.revoked) break;
      trackModalPreferenceReceipts.set(row, {scope: scope.token, request: replacementReceipt || previousReceipt, inventoryRevision,
        signature: JSON.stringify(source), source: Object.freeze(source)});
    }
    if (replacementReceipt) {
      // Batch subscribers are synchronous. Publish no replacement if they
      // retired this request; notify receipt consumers only after siblings
      // have their own receipts, without transferring any old object grants.
      if (!requestCurrent() || previousReceipt.revoked) {replacementReceipt.revoked = true; return;}
      previousReceipt.revoked = true;
      requestReceipt = replacementReceipt;
      trackModalPreferenceSources.delete(key);
      trackModalPreferenceSources.set(key, replacementReceipt);
      trimTrackModalPreferenceSources();
      notifyTrackModalPreferences();
    }
  }});
}

function admitLooseTrackPreferenceRows(payload, preferenceRead) {
  if (!preferenceRead || !payload || payload.read_only_subject
    || String(payload.surface?.active || payload.surface_request || 'albums') !== 'albums') return;
  if (!trackModalPreferenceContainerReadable(payload)) {
    preferenceRead.revoke();
    return;
  }
  preferenceRead.admit(Array.isArray(payload.non_album_tracks) ? payload.non_album_tracks : []);
}

async function fetchTrackModalAlbumDetails(albumKey, options = {}) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return null;
  const preferenceRead = captureTrackModalPreferenceRead('album', normalizedAlbumKey, options);
  const albumPreferenceScope = captureRuntimeAlbumPreferenceScope();
  const response = await fetch(`/album-details?album_key=${encodeURIComponent(normalizedAlbumKey)}`, {
    headers: { Accept: 'application/json' },
    priority: options.speculative === true ? 'low' : 'high',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  if (!response.ok || !payload?.ok || !payload?.album) {
    if (response.status === 401 || response.status === 403) preferenceRead.revoke();
    throw Object.assign(new Error(payload?.error || `Album detail request failed: ${response.status}`), {status: response.status});
  }
  if (payload.album.source_readable === false || payload.album.allowed_actions?.can_read === false) preferenceRead.revoke();
  if (trackModalPreferenceContainerReadable(payload.album)
    && String(payload.album.key || payload.album.album_ref || '') === normalizedAlbumKey
    && !(typeof albumRequiresHydration === 'function' && albumRequiresHydration(payload.album))) {
    const rows = [], containers = [payload.album], seen = new Set();
    for (const container of containers) {
      if (!trackModalPreferenceContainerReadable(container) || seen.has(container)) continue;
      seen.add(container);
      containers.push(...(Array.isArray(container.duplicate_sources) ? container.duplicate_sources : []));
      rows.push(...(Array.isArray(container.tracks) ? container.tracks : []),
        ...(Array.isArray(container.track_rows) ? container.track_rows : []),
        ...(Array.isArray(container.gallery_list_block?.track_rows) ? container.gallery_list_block.track_rows : []));
    }
    preferenceRead.admit(rows);
  }
  if (options.signal?.aborted || options.isCurrent && options.isCurrent() !== true
    || albumPreferenceScope && !runtimeAlbumPreferenceScopeIsCurrent(albumPreferenceScope)) {
    throw Object.assign(new Error('Album details were superseded.'), {name: 'AbortError'});
  }
  if (options.readOnlySubject !== true && options.admitPreferences !== false
    && String(payload.album.key || payload.album.album_ref || '') === normalizedAlbumKey) {
    admitRuntimeAlbumPreferenceRead(payload.album, albumPreferenceScope);
  }
  return payload.album;
}

function loadTrackModalAlbumDetails(albumKey, options = {}) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return Promise.resolve(null);
  const cachedAlbum = getCachedHydratedTrackModalAlbum(normalizedAlbumKey);
  if (cachedAlbum) return Promise.resolve(cachedAlbum);
  const requestAliases = getTrackModalAlbumKeyAliases(normalizedAlbumKey);
  const existingLoad = requestAliases
    .map((alias) => trackModalAlbumDetailsLoads.get(alias))
    .find(Boolean);
  if (existingLoad) {
    const speculativeController = trackModalSpeculativeAlbumDetailsLoadControllers.get(existingLoad);
    if (options.speculative === true || !speculativeController) return existingLoad;
    trackModalSpeculativeAlbumDetailsLoadControllers.delete(existingLoad);
    trackModalSpeculativePrewarmControllers.delete(speculativeController);
    return existingLoad;
  }
  const requestInventoryRevision = Number(state?.status?.inventory_mutation_revision || 0);
  let load = null;
  load = fetchTrackModalAlbumDetails(normalizedAlbumKey, options)
    .then((album) => {
      const currentAlbum = getCachedHydratedTrackModalAlbum(normalizedAlbumKey);
      const currentClaim = trackModalHydratedAlbumDetailsLru.get(currentAlbum)?.tagEditMutationClaim;
      if (currentClaim && typeof tagEditViewMutationStillOwnsResources === 'function'
          && tagEditViewMutationStillOwnsResources(currentClaim)) {
        // A response started before an edit cannot replace its pending membership,
        // even before that edit advances the inventory revision.
        return currentAlbum;
      }
      if (requestInventoryRevision !== Number(state?.status?.inventory_mutation_revision || 0)) {
        // Release only this request's aliases before joining or starting a load
        // under the current revision. Foreground callers never receive stale data.
        trackModalAlbumDetailsLoads.forEach((mappedLoad, alias) => {
          if (mappedLoad === load) trackModalAlbumDetailsLoads.delete(alias);
        });
        const promotedToForeground = options.speculative === true
          && options.controller
          && !trackModalSpeculativeAlbumDetailsLoadControllers.has(load);
        return loadTrackModalAlbumDetails(normalizedAlbumKey,
          promotedToForeground ? { ...options, speculative: false } : options);
      }
      cacheHydratedTrackModalAlbum(normalizedAlbumKey, album);
      getTrackModalAlbumKeyAliases(normalizedAlbumKey, album).forEach((alias) => {
        trackModalAlbumDetailsLoads.set(alias, load);
      });
      return album;
    })
    .finally(() => {
      trackModalSpeculativeAlbumDetailsLoadControllers.delete(load);
      trackModalAlbumDetailsLoads.forEach((mappedLoad, alias) => {
        if (mappedLoad === load) trackModalAlbumDetailsLoads.delete(alias);
      });
    });
  if (options.speculative === true && options.controller) {
    trackModalSpeculativeAlbumDetailsLoadControllers.set(load, options.controller);
  }
  requestAliases.forEach((alias) => trackModalAlbumDetailsLoads.set(alias, load));
  return load;
}

function queueTrackModalAlbumDetailsPrewarm(albumKey) {
  const normalizedAlbumKey = String(albumKey || '').trim();
  if (!normalizedAlbumKey) return;
  const committedQuery = String(state?.view?.query || '');
  const draftQuery = String(state?.ui?.searchDraftQuery ?? committedQuery);
  if (
    state?.busy
    || state?.ui?.albumDetailPrewarmSearchSuspended
    || draftQuery !== committedQuery
  ) return;
  if (getCachedHydratedTrackModalAlbum(normalizedAlbumKey)) return;
  const indexedAlbum = getIndexedAlbum(normalizedAlbumKey);
  if (!albumRequiresHydration(indexedAlbum)) return;
  const existingLoad = getTrackModalAlbumKeyAliases(normalizedAlbumKey)
    .map((alias) => trackModalAlbumDetailsLoads.get(alias))
    .find(Boolean);
  if (existingLoad) {
    existingLoad.catch(() => {});
    return;
  }
  if (trackModalActiveSpeculativePrewarms >= TRACK_MODAL_SPECULATIVE_PREWARM_LIMIT) return;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller) trackModalSpeculativePrewarmControllers.add(controller);
  trackModalActiveSpeculativePrewarms += 1;
  loadTrackModalAlbumDetails(normalizedAlbumKey, {
    controller,
    signal: controller?.signal,
    speculative: true,
  }).catch(() => {
    // User-facing errors are shown only when the user actually opens the modal.
  }).finally(() => {
    if (controller) trackModalSpeculativePrewarmControllers.delete(controller);
    trackModalActiveSpeculativePrewarms = Math.max(0, trackModalActiveSpeculativePrewarms - 1);
  });
}

function cancelTrackModalAlbumDetailsPrewarms() {
  trackModalSpeculativePrewarmControllers.forEach((controller) => controller.abort());
  trackModalSpeculativePrewarmControllers.clear();
}

function queueVisibleTrackModalAlbumDetailsPrewarm(containerEl, scrollEl, limit = 2) {
  if (!(containerEl instanceof HTMLElement) || !(scrollEl instanceof HTMLElement)) return;
  const scrollRect = scrollEl.getBoundingClientRect();
  const visibleButtons = [];
  containerEl.querySelectorAll('.album-title-button[data-open-tracklist="1"][data-album-key]').forEach((button) => {
    if (!(button instanceof HTMLElement)) return;
    const rect = button.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return;
    if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) return;
    visibleButtons.push(button);
  });
  if (!visibleButtons.length || visibleButtons.length > limit) return;
  visibleButtons.forEach((button) => {
    const albumKey = String(button.getAttribute('data-album-key') || '').trim();
    if (!albumKey) return;
    queueTrackModalAlbumDetailsPrewarm(albumKey);
  });
}

let trackModalArtworkPreload = null;

function preloadTrackModalArtwork(album) {
  if (typeof Image !== 'function' || typeof buildAlbumLightboxCoverUrl !== 'function') return;
  const source = buildAlbumLightboxCoverUrl(album);
  if (!source || trackModalArtworkPreload?.source === source) return;
  const image = new Image();
  trackModalArtworkPreload = { source, image };
  image.fetchPriority = 'low';
  image.decoding = 'async';
  image.onerror = () => {
    if (trackModalArtworkPreload?.image === image) trackModalArtworkPreload = null;
  };
  image.src = source;
}

function openTrackModal(album, options = {}) {
  if (!album) return false;
  const attempt = options.searchPresentationAttempt || null;
  const current = () => !attempt || attempt.isCurrent() === true;
  if (!current()) return false;
  if (typeof deferAppFormPageReplacement === 'function' && deferAppFormPageReplacement(() => {
    if (typeof options.deferResourceSelection === 'function') return options.deferResourceSelection();
    if (!current()) return false;
    return openTrackModal(album, options);
  })) {attempt?.dispose('form-deferred'); return;}
  const inherited = options.presentationRestrictions === undefined && options.releaseSet
    ? trackModalPresentationRestrictions : options.presentationRestrictions;
  const restrictions = normalizeTrackModalPresentationRestrictions(inherited);
  const sourcePageOwner = resolveTrackModalSourcePageOwner(options.sourcePageOwner === undefined && options.releaseSet
    ? trackModalSourcePageOwner : options.sourcePageOwner, String(getAlbumRequestKey(album) || ''), restrictions);
  if (sourcePageOwner) {try {if (sourcePageOwner.isCurrent() !== true) return false;} catch {return false;}}
  if (!restrictions.can_open_album_page && typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()) return false;
  const inheritingSheet = options.artistSheetGeneration === artistSheetGeneration
    && options.artistSheetOrigin === artistSheetOrigin;
  if (options.artistSheetGeneration !== undefined && !inheritingSheet) return false;
  let origin = inheritingSheet ? artistSheetOrigin : options.artistSheetOrigin || null;
  if (!origin && options.releaseSet && artistSheetOrigin) origin = artistSheetOrigin.retarget(album);
  if (origin && (!restrictions.can_open_album_page || sourcePageOwner)) {origin.release(); origin = null;}
  if (!inheritingSheet) {
    if (typeof mobilePageState !== 'undefined' && mobilePageState.sheetDismissal) {
      settleMobileArtistSheetDismissal(mobilePageState.sheetDismissal.descriptor, false);
    }
    const previous = artistSheetOrigin;
    artistSheetGeneration += 1; artistSheetOrigin = origin;
    disposeTrackModalArtistSheet();
    if (previous && previous !== origin) previous.release();
  }
  options = {...options, presentationRestrictions: restrictions, sourcePageOwner,
    artistSheetOrigin: origin, artistSheetGeneration};
  const openingGeneration = artistSheetGeneration;
  if (!current()) return false;
  retireTrackModalSearchPresentation('modal-replace');
  releaseTrackModalSelection('modal');
  if (artistSheetGeneration !== openingGeneration || !current()) return false;
  trackModalSourcePageReplay = null;
  trackModalPresentationRestrictions = restrictions;
  trackModalSourcePageOwner = sourcePageOwner;
  retainTrackModalSourcePageOwner(sourcePageOwner);
  if (typeof cancelMobileArtistSheetReturn === 'function') cancelMobileArtistSheetReturn();
  if (album && restrictions.can_open_album_page && typeof presentMobileAlbumPage === 'function') {
    let presented = false;
    try {presented = presentMobileAlbumPage(album) !== false;}
    finally {
      if (!presented && origin && artistSheetOrigin === origin && artistSheetGeneration === openingGeneration) {
        artistSheetOrigin = null; artistSheetGeneration += 1;
        origin.release(); disposeTrackModalArtistSheet();
      }
    }
    if (!presented && origin) return false;
  }
  if (artistSheetGeneration !== openingGeneration || !current()) return false;
  const els = getTrackModalElements();
  if (!els.overlay || !album) return;
  trackModalCleanupGeneration += 1;
  if (canViewTrackModalArtwork()) preloadTrackModalArtwork(album);
  if (options.foreground && document.getElementById('utility-modal')?.hidden === false) {
    els.overlay.classList.add('is-above-settings');
  }
  state.ui.trackModalCoverLightboxGallery = options.coverLightboxGallery !== false;
  if (typeof clearPendingSelectedArtistReconcile === 'function') {
    clearPendingSelectedArtistReconcile();
  }
  const albumWithPlaybackContext = attachGalleryPlaybackContextToAlbum(album);
  if (albumRequiresHydration(albumWithPlaybackContext)) {
    // Search operations already hydrated under their source owner. Never let a
    // deferred cache read retain or revive their staged presentation attempt.
    if (attempt) return false;
    const albumKey = getAlbumRequestKey(albumWithPlaybackContext);
    const loadToken = invalidatePendingTrackModalLoad();
    state.ui.pendingTrackModalLoadAlbumKey = albumKey;
    openTrackModalShell(albumWithPlaybackContext, options.releaseSet);
    const coverLoadSuspensionToken = suspendGalleryCoverLoadsForTrackModal();
    const detailsPromise = loadTrackModalAlbumDetails(albumKey);
    detailsPromise.then((hydratedAlbum) => {
      if (loadToken !== state.ui.pendingTrackModalLoadToken) return;
      const refreshedAlbum = getIndexedAlbum(albumKey);
      const resolvedAlbum = (!refreshedAlbum || albumRequiresHydration(refreshedAlbum))
        ? hydratedAlbum
        : refreshedAlbum;
      if (loadToken !== state.ui.pendingTrackModalLoadToken) return;
      if (!resolvedAlbum || albumRequiresHydration(resolvedAlbum) || els.overlay.hidden) return;
      invalidatePendingTrackModalLoad();
      openTrackModal(resolvedAlbum, { ...options, foreground: false });
    }).catch((error) => {
      if (loadToken !== state.ui.pendingTrackModalLoadToken) return;
      console.error('[AlbumHaven][AlbumDetails] Failed to load full album details.', error);
      showToast('Unable to load album details.', 'error', 3200);
    }).finally(() => {
      resumeGalleryCoverLoadsAfterTrackModalAction(coverLoadSuspensionToken);
    });
    return;
  }
  invalidatePendingTrackModalLoad();
  // Edition hydration must not rebuild the tabs around a different base name.
  const preserved = options.releaseSet;
  const preservedAlbum = preserved?.releases?.[preserved.selectedIndex];
  const releaseSet = preservedAlbum
    && getAlbumRequestKey(preservedAlbum) === getAlbumRequestKey(albumWithPlaybackContext)
    ? {
      releases: preserved.releases.map((release, index) => {
        if (index !== preserved.selectedIndex) return release;
        const copy = { ...albumWithPlaybackContext, tabLabel: release.tabLabel };
        if (typeof SearchAlbumPresentationProvenance !== 'undefined') SearchAlbumPresentationProvenance.bridge(albumWithPlaybackContext, copy);
        return copy;
      }),
      selectedIndex: preserved.selectedIndex,
    }
    : getAlbumReleaseSet(albumWithPlaybackContext);
  if (attempt && typeof SearchAlbumPresentationProvenance !== 'undefined') {
    for (const release of releaseSet.releases) SearchAlbumPresentationProvenance.mark(release);
  }
  if (!current()) return false;
  state.modalReleases = releaseSet.releases;
  state.modalReleaseIndex = releaseSet.selectedIndex;
  hideVersionContextMenu();
  const renderedAlbum = state.modalReleases[state.modalReleaseIndex];
  renderTrackModalRelease(renderedAlbum);
  if (!current() || getCurrentTrackModalAlbum() !== renderedAlbum || getTrackModalElements().list !== els.list) return false;
  els.overlay.hidden = false;
  document.body.classList.add('modal-open');
  if (typeof NativePlaytables !== 'undefined') NativePlaytables.mount('album-tracks', els.list);
  attachSharedPlayer();
  updateTrackModalArtistSheet();
  if (attempt) {
    if (!current() || getCurrentTrackModalAlbum() !== renderedAlbum || getTrackModalElements().list !== els.list
      || !els.list?.isConnected || els.overlay.hidden || getTrackModalSelectionLease()) return false;
    if (!attempt.commit()) return false;
    if (!current() || getCurrentTrackModalAlbum() !== renderedAlbum || getTrackModalElements().list !== els.list
      || els.overlay.hidden || getTrackModalSelectionLease()) {attempt.dispose('commit-superseded'); return false;}
    trackModalSearchPresentation = attempt;
  }
}

function getCurrentTrackModalAlbum() {
  return state.modalReleases[state.modalReleaseIndex] || null;
}

function getTrackModalButtonAlbumKey(button) {
  if (!(button instanceof HTMLElement)) return '';
  return (typeof button.getAttribute === 'function' ? button.getAttribute('data-album-key') : '')
    || button.dataset.albumKey
    || '';
}

function getTrackModalButtonAlbumVersionKey(button) {
  if (!(button instanceof HTMLElement)) return '';
  return (typeof button.getAttribute === 'function' ? button.getAttribute('data-album-version-key') : '')
    || button.dataset.albumVersionKey
    || '';
}

function parseTrackModalButtonAlbumFallback(button) {
  if (!(button instanceof HTMLElement)) return null;
  try {
    const parsedAlbum = JSON.parse(button.getAttribute('data-album') || 'null');
    return parsedAlbum && typeof parsedAlbum === 'object' ? parsedAlbum : null;
  } catch (_error) {
    return null;
  }
}

function findIndexedTrackModalLogicalRelease(album) {
  if (!album || !(state?.gallery?.albumIndex instanceof Map)) return null;
  const matches = Array.from(new Set(state.gallery.albumIndex.values())).filter(
    (candidate) => trackModalAlbumsShareLogicalRelease(candidate, album),
  );
  return matches.length === 1 ? matches[0] : null;
}

function resolveTrackModalActionAlbum(button) {
  const albumKey = String(getTrackModalButtonAlbumKey(button) || '').trim();
  const albumVersionKey = String(getTrackModalButtonAlbumVersionKey(button) || '').trim();
  const currentAlbum = getCurrentTrackModalAlbum();
  const fallbackAlbum = parseTrackModalButtonAlbumFallback(button);
  if (albumVersionKey) {
    const currentAlbumVersionKey = getTrackModalAlbumVersionKey(currentAlbum);
    if (currentAlbum && !albumRequiresHydration(currentAlbum) && currentAlbumVersionKey === albumVersionKey) {
      return currentAlbum;
    }
    const cachedVersionAlbum = getCachedHydratedTrackModalAlbum(albumVersionKey);
    if (cachedVersionAlbum) return cachedVersionAlbum;
    const indexedVersionAlbum = getIndexedAlbum(albumVersionKey);
    if (indexedVersionAlbum) return indexedVersionAlbum;
  }
  if (albumKey) {
    const currentAlbumKey = String(getAlbumRequestKey(currentAlbum) || getAlbumIdentity(currentAlbum) || currentAlbum?.key || '');
    if (currentAlbum && !albumRequiresHydration(currentAlbum) && currentAlbumKey === albumKey) {
      return currentAlbum;
    }
    const cachedAlbum = getCachedHydratedTrackModalAlbum(albumKey);
    if (currentAlbum && cachedAlbum === currentAlbum) {
      return currentAlbum;
    }
    const indexedAlbum = getIndexedAlbum(albumKey);
    if (indexedAlbum) return indexedAlbum;
    if (currentAlbumKey === albumKey) {
      return currentAlbum;
    }
  }
  if (currentAlbum) return currentAlbum;
  return findIndexedTrackModalLogicalRelease(fallbackAlbum) || fallbackAlbum;
}

function resolveTrackModalDuplicateSourceAlbum(button) {
  const album = resolveTrackModalActionAlbum(button);
  if (!album || !(button instanceof HTMLElement)) return album;
  const duplicateSources = Array.isArray(album?.duplicate_sources) ? album.duplicate_sources : [];
  const sourceIndex = Number(button.getAttribute('data-duplicate-source-index'));
  if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= duplicateSources.length) {
    return album;
  }
  return {
    ...album,
    tracks: Array.isArray(duplicateSources[sourceIndex]?.tracks) ? duplicateSources[sourceIndex].tracks : [],
  };
}

function getTrackModalLightboxSourceAlbumKey(button) {
  const album = resolveTrackModalActionAlbum(button);
  if (!album || typeof album !== 'object') return '';
  if (typeof getAlbumPathSignature === 'function') {
    const signature = getAlbumPathSignature(album);
    if (signature) return signature;
  }
  return String(getAlbumIdentity(album) || album?.key || `${album?.name || ''}::${album?.album_artist || ''}`);
}

let imageLightboxReturnFocus = null;
let imageLightboxHistoryOpen = false;
let imageLightboxHistoryClosing = false;

function handleImageLightboxPopState() {
  if (!imageLightboxHistoryOpen) return false;
  imageLightboxHistoryOpen = false;
  imageLightboxHistoryClosing = false;
  closeImageLightbox();
  return true;
}

function bindLightboxSwipe(overlay) {
  if (overlay.dataset.swipeBound === '1') return;
  overlay.dataset.swipeBound = '1';
  let start = null;
  overlay.addEventListener('touchstart', event => {
    start = !overlay.hidden && typeof usesMobilePageLayout === 'function'
      && usesMobilePageLayout() && state.lightbox.zoom <= 1 && event.touches.length === 1
      ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  }, { passive: true });
  overlay.addEventListener('touchmove', event => {
    if (event.touches.length !== 1 || state.lightbox.zoom > 1) start = null;
  }, { passive: true });
  overlay.addEventListener('touchcancel', () => { start = null; }, { passive: true });
  overlay.addEventListener('touchend', event => {
    const origin = start;
    start = null;
    if (!origin || overlay.hidden || state.lightbox.zoom > 1 || event.touches.length) return;
    const end = event.changedTouches[0];
    const dx = end.clientX - origin.x;
    const dy = end.clientY - origin.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    event.preventDefault();
    stepLightbox(dx < 0 ? 1 : -1);
  }, { passive: false });
}

function openImageLightbox(src, alt, options = {}) {
  const els = getLightboxElements();
  if (!els.overlay || !els.image || !src) return;
  if (els.overlay.hidden) imageLightboxReturnFocus = document.activeElement;
  if (els.overlay.hidden && typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()
      && typeof window !== 'undefined' && window.history?.pushState) {
    window.history.pushState({ ...window.history.state, imageLightbox: true }, '');
    imageLightboxHistoryOpen = true;
    imageLightboxHistoryClosing = false;
  }
  bindLightboxSwipe(els.overlay);
  bindOverlayPointerOrigin(els.overlay);
  state.lightbox.sourceAlbumKey = String(options.sourceAlbumKey || '');
  state.lightbox.items = Array.isArray(options.items) ? options.items.filter(Boolean) : [];
  state.lightbox.currentIndex = -1;
  const itemIndex = state.lightbox.items.findIndex((item) => (
    item?.src === src || (state.lightbox.sourceAlbumKey && item?.key === state.lightbox.sourceAlbumKey)
  ));
  if (itemIndex >= 0) {
    showLightboxItem(itemIndex);
  } else {
    const standaloneItem = {
      src,
      previewSrc: String(options.previewSrc || ''),
      remoteSrc: String(options.remoteSrc || ''),
      alt: alt || 'Full-size album cover',
    };
    if (typeof showStandaloneLightboxItem === 'function') {
      showStandaloneLightboxItem(standaloneItem);
    } else {
      els.image.src = src;
      els.image.alt = standaloneItem.alt;
    }
    state.lightbox.panX = 0;
    state.lightbox.panY = 0;
    state.lightbox.dragging = false;
    setLightboxZoom(1);
    updateLightboxNavState();
  }
  els.overlay.hidden = false;
  els.overlay.setAttribute?.('role', 'dialog');
  els.overlay.setAttribute?.('aria-modal', 'true');
  els.overlay.setAttribute?.('aria-label', 'Full-size album cover');
  document.body.classList.add('modal-open');
  els.close?.focus?.();
}

function closeImageLightbox() {
  if (imageLightboxHistoryOpen) {
    if (!imageLightboxHistoryClosing) {
      imageLightboxHistoryClosing = true;
      window.history.back();
    }
    return;
  }
  const els = getLightboxElements();
  if (!els.overlay || !els.image) return;
  els.overlay.hidden = true;
  stopLightboxDrag();
  state.lightbox.panX = 0;
  state.lightbox.panY = 0;
  state.lightbox.items = [];
  state.lightbox.currentIndex = -1;
  state.lightbox.sourceAlbumKey = '';
  state.lightbox.activeSources = [];
  state.lightbox.activeSourceIndex = -1;
  state.lightbox.activeFullSource = '';
  state.lightbox.activeAlt = '';
  state.lightbox.loadToken = Number(state.lightbox.loadToken || 0) + 1;
  if (state.lightbox.activePreloader) {
    state.lightbox.activePreloader.onload = null;
    state.lightbox.activePreloader.onerror = null;
    state.lightbox.activePreloader = null;
  }
  setLightboxZoom(1);
  els.image.onload = null;
  els.image.onerror = null;
  if (els.loading) els.loading.hidden = true;
  els.image.hidden = true;
  if (els.image.classList?.remove) els.image.classList.remove('is-unavailable');
  els.image.removeAttribute('src');
  els.image.alt = '';
  if (typeof els.image.setAttribute === 'function') els.image.setAttribute('aria-hidden', 'true');
  updateLightboxNavState();
  const trackModalOpen = !document.getElementById('track-modal')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  if (!trackModalOpen && !utilityModalOpen) {
    document.body.classList.remove('modal-open');
  }
  const returnFocus = imageLightboxReturnFocus;
  imageLightboxReturnFocus = null;
  if (returnFocus?.isConnected && resumeTrackModalArtistSheetForFocus(returnFocus)) returnFocus.focus?.();
}

function closeTrackModal() {
  retireTrackModalSearchPresentation('close');
  if (typeof disposeTrackModalAlbumPreferences === 'function') disposeTrackModalAlbumPreferences();
  releaseTrackModalSelection('close');
  if (typeof dismissMobilePage === 'function' && dismissMobilePage('album')) return;
  const retiredOrigin = artistSheetOrigin;
  artistSheetOrigin = null; artistSheetGeneration += 1;
  const closingGeneration = artistSheetGeneration;
  disposeTrackModalArtistSheet(); retiredOrigin?.release();
  if (artistSheetGeneration !== closingGeneration) return;
  trackModalPresentationRestrictions = null;
  trackModalSourcePageOwner = null;
  const els = getTrackModalElements();
  if (!els.overlay) return;
  const cleanupGeneration = ++trackModalCleanupGeneration;
  const coverLoadSuspensionTokens = takeAllGalleryCoverLoadSuspensionTokens();
  els.overlay.hidden = true;
  els.overlay.classList.remove('is-above-settings');
  invalidatePendingTrackModalLoad();
  state.modalReleases = [];
  state.modalReleaseIndex = 0;
  hideVersionContextMenu();
  const lightboxOpen = !document.getElementById('image-lightbox')?.hidden;
  const utilityModalOpen = !document.getElementById('utility-modal')?.hidden;
  if (!lightboxOpen && !utilityModalOpen) {
    document.body.classList.remove('modal-open');
  }
  scheduleTrackModalCleanupAfterPaint(cleanupGeneration, coverLoadSuspensionTokens);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof Event === 'function') {
    window.dispatchEvent(new Event('albumhaven:resource-selection-available'));
  }
}

function openTrackModalForButton(button) {
  if (!(button instanceof HTMLElement)) return false;
  const albumKey = (typeof button.getAttribute === 'function' ? button.getAttribute('data-album-key') : '')
    || button.dataset.albumKey
    || '';
  if (!albumKey) return false;
  const album = resolveTrackModalActionAlbum(button);
  const origin = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()
    ? window.AlbumHavenArtistPageRuntime?.captureAlbumSheetOrigin(button, album) : null;
  openTrackModal(album, {artistSheetOrigin: origin});
  return true;
}

function attachTrackButtons() {
  document.querySelectorAll('[data-open-tracklist="1"]').forEach((button) => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', () => {
      openTrackModalForButton(button);
    });
  });
}

// Escape belongs to the visible foreground overlay, even when focus is behind it.
function getTopmostOpenModal() {
  const overlays = '.track-modal, .utility-modal, .confirm-modal, .tag-editor-modal, .cover-lookup-modal, .non-album-modal, .image-lightbox, .repair-progress-overlay';
  const candidates = [...new Set(Array.from(document.querySelectorAll(
    `${overlays}, [aria-modal="true"], #app-form-modal`,
  )).map(node => node.closest(overlays) || node))];
  const stack = node => {
    const contexts = [];
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.zIndex !== 'auto' && style.zIndex !== ''
          || ['fixed', 'sticky'].includes(style.position)
          || Number(style.opacity) < 1
          || style.transform && style.transform !== 'none'
          || style.filter && style.filter !== 'none'
          || style.isolation === 'isolate'
          || /paint|layout|strict|content/.test(style.contain || '')) {
        contexts.unshift({ node: current, z: Number(style.zIndex) || 0 });
      }
    }
    return contexts;
  };
  const visible = candidates.filter(node => {
    if (node.classList?.contains?.('is-mobile-page')) return false;
    if (node.closest('[hidden], [inert]') || !node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }).map(node => ({ node, stack: stack(node) }));
  visible.sort((a, b) => {
    let index = 0;
    while (a.stack[index] && b.stack[index] && a.stack[index].node === b.stack[index].node) index += 1;
    const left = a.stack[index];
    const right = b.stack[index];
    const order = (left?.z || 0) - (right?.z || 0);
    if (order) return order;
    return (left?.node || a.node).compareDocumentPosition(right?.node || b.node) & 4 ? -1 : 1;
  });
  return visible.at(-1)?.node || null;
}

function handleModalEscapeKeydown(event) {
  if (event.key !== 'Escape') return;
  const modal = getTopmostOpenModal();
  if (!modal) return;
  // Capture and stop immediately: closing one dialog must not expose another
  // to this same keypress, including handlers attached directly to its controls.
  event.stopImmediatePropagation?.();
  if (event.defaultPrevented) return;
  event.preventDefault?.();
  if (event.repeat || event.isComposing) return;
  const form = modal.id === 'app-form-modal' && typeof getActiveAppFormPage === 'function' ? getActiveAppFormPage() : null;
  if (form) {void form.dismiss('escape'); return;}
  if (modal.id === 'tag-editor-modal') {
    if (state.tagEditor.reorder) {
      clearTagEditorReorderCue();
    } else if (getSelectedTagEditorPaths(state.tagEditor.tracks || []).length > 1) {
      setTagEditorSelectedPaths([]);
      state.tagEditor.anchorPath = '';
      renderTagEditor({ preserveTrackList: true });
    } else {
      closeTagEditor();
    }
    return;
  }
  if (modal.id === 'utility-modal') {
    if (state.utility.activeTab === 'problematic-files' && state.utility.problemDropdownOpen) {
      const els = getUtilityModalElements();
      state.utility.problemDropdownOpen = false;
      els.problemFilterMenu.hidden = true;
      els.problemFilterButton.setAttribute('aria-expanded', 'false');
      if (typeof clearTriggerAnchor === 'function') clearTriggerAnchor(els.problemFilterMenu);
      els.problemFilterButton.focus();
      return;
    }
    if (typeof cancelActiveSavedLoopCreation === 'function' && cancelActiveSavedLoopCreation()) return;
    const editor = typeof getBackgroundAppearanceEditor === 'function' ? getBackgroundAppearanceEditor() : null;
    if (editor?.allowLeave(() => true) === false) return;
    closeUtilityModal(true);
    return;
  }
  dismissForegroundModal(modal);
}

function dismissForegroundModal(modal) {
  if (modal.id === 'tag-editor-modal') { closeTagEditorFromBackdrop(); return; }
  if (modal.id === 'utility-modal') { closeUtilityModal(); return; }
  const close = {
    'track-modal': () => closeTrackModal(),
    'image-lightbox': () => closeImageLightbox(),
    'repair-confirm-modal': () => closeRepairConfirmModal(),
    'tag-edit-confirm-modal': () => closeTagEditConfirmModal(),
    'cover-lookup-modal': () => closeCoverLookupModal(),
    'cover-lookup-delete-confirm-modal': () => closeCoverLookupDeleteConfirm(),
    'non-album-modal': () => closeNonAlbumModal(),
    'version-picker-modal': () => closeVersionPickerModal(),
  }[modal.id];
  if (close) close();
  else {
    // Promise-backed dialogs must settle through their own cancel actions.
    modal.querySelector('#app-confirm-cancel, #app-form-cancel, #loop-name-cancel, #loop-delete-confirm-cancel')?.click();
  }
}

function attachModalEvents() {
  const els = getTrackModalElements();
  if (!els.overlay || els.overlay.dataset.bound === '1') return;
  els.overlay.dataset.bound = '1';
  bindOverlayPointerOrigin(els.overlay);
  els.overlay.addEventListener('click', (event) => {
    if (els.overlay.hidden || event.defaultPrevented) return;
    if ((!els.overlay.classList.contains('is-artist-discography-sheet') && overlayClickStartedOnOverlay(els.overlay, event)) || event.target.closest('[data-close-track-modal="1"]')) {
      closeTrackModal();
    }
  });
  document.addEventListener('keydown', handleModalEscapeKeydown, true);
  document.addEventListener('keydown', (event) => {
    const lightboxEls = getLightboxElements();
    if (!lightboxEls.overlay || lightboxEls.overlay.hidden) return;
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const controls = Array.from(lightboxEls.overlay.querySelectorAll?.('button, [href], input, select, textarea, [tabindex]') || [])
        .filter(control => !control.hidden && !control.disabled && control.tabIndex >= 0
          && !control.closest?.('[hidden], [inert]') && control.getClientRects().length > 0);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) return;
      const outside = !lightboxEls.overlay.contains(document.activeElement);
      if (outside || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      stepLightbox(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      stepLightbox(1);
    }
  });
}
