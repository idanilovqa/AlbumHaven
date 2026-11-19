/* Responsive shell navigation. Existing components retain their data and event owners. */
const mobilePageState = { pages: [], originals: new Map(), restoring: false, cleaning: false, initialized: false, searchOpen: false };
// The server's tab title, before any page renames the tab; restored whenever no page is open.
const albumHavenBaseDocumentTitle = typeof document === 'undefined' ? '' : String(document.title || '');
const mobileLiveGalleryParents = new WeakMap();
const MOBILE_PAGE_KINDS = Object.freeze({ album: 'track-modal', utilities: 'utility-modal', 'cover-lookup': 'cover-lookup-modal', 'non-album': 'non-album-modal' });

function isMobileClient() {
  return window.AlbumHavenDevicePreferences?.profile?.() === 'mobile'
    || window.AlbumHavenClientLayout?.classifyProfile({ viewportWidth: window.innerWidth, userAgent: window.navigator?.userAgent,
      platform: window.navigator?.platform, maxTouchPoints: window.navigator?.maxTouchPoints }) === 'mobile';
}
function usesMobilePageLayout() { return Number(window.innerWidth) <= 900; }
function mobilePageDescriptor(kind, album = null, options = {}) {
  const albumKey = album ? String(getAlbumRequestKey(album) || '') : '';
  const subtitle = album ? [kind === 'cover-lookup' ? album.name : '', album.album_artist || album.artist, album.year, album.total_duration_display].filter(Boolean).join(' · ') : '';
  return { kind, albumKey, title: kind === 'utilities' ? 'Settings' : kind === 'cover-lookup' ? 'Cover Art Look Up' : kind === 'non-album' ? 'Loose Tracks' : String(album?.name || 'Album'),
    libraryWide: kind === 'non-album' && options.libraryWide === true,
    collectionName: kind === 'non-album' ? String(options.collectionName || '').trim() : '',
    navigationSource: kind === 'non-album' && options.navigationSource === 'library-tree' ? 'library-tree' : 'artist',
    subtitle, coverSrc: album && typeof albumHasDisplayCover === 'function' && albumHasDisplayCover(album) ? buildAlbumDisplayCoverUrl(album) : '', tab: kind === 'utilities' ? state.utility.activeTab : '' };
}
function syncMobilePageShell() {
  const mobile = usesMobilePageLayout();
  const active = mobile ? mobilePageState.pages.at(-1) : null;
  if (!mobile || active) cancelMobileGalleryPinch();
  const main = document.getElementById('shell-main-surface');
  const header = document.getElementById('mobile-page-header');
  const outlet = document.getElementById('mobile-page-outlet');
  if (!main || !header || !outlet) return;
  main.classList.toggle('has-mobile-page', Boolean(active));
  header.hidden = !active;
  outlet.hidden = !active;
  outlet.dataset.mobilePageKind = active?.kind || '';
  const libraryTreePage = active?.kind === 'non-album' && active.navigationSource === 'library-tree';
  document.getElementById('mobile-back-button').hidden = !active || libraryTreePage;
  const pageLibraryButton = document.getElementById('mobile-page-library-button');
  if (pageLibraryButton) pageLibraryButton.hidden = !libraryTreePage;
  document.getElementById('mobile-library-button').hidden = Boolean(active);
  for (const kind of mobilePageState.originals.keys()) {
    const element = document.getElementById(MOBILE_PAGE_KINDS[kind]);
    setMobilePagePresentation(kind, mobile);
    if (element) { element.hidden = mobile && kind !== active?.kind; element.inert = mobile && kind !== active?.kind; }
  }
  if (active) {
    document.getElementById('mobile-page-title').textContent = active.title;
    const summary = document.getElementById('mobile-page-summary');
    summary.textContent = active.subtitle;
    if (active.loopCount) { const count = document.createElement('span'); count.className = 'mobile-loop-count'; count.textContent = active.loopCount; summary.appendChild(count); }
  }
  syncAlbumHavenDocumentTitle();
  document.getElementById('mobile-settings-actions').hidden = active?.kind !== 'utilities';
  document.getElementById('mobile-settings-button').hidden = active?.kind !== 'utilities';
  syncMobileAlbumHeader();
  syncMobileLoopHeader();
  // A page is not a modal and must never trap focus away from the persistent player.
  const hasModal = [...document.querySelectorAll('[aria-modal="true"]:not([hidden])')]
    .some(dialog => dialog.getClientRects().length > 0);
  if (!hasModal) document.body.classList.remove('modal-open');
  else if (!mobile) document.body.classList.add('modal-open');
}

// Transfer the existing surface only; descriptors and history continue to own
// its parent stack across breakpoint changes, and closing remains owner-driven.
function setMobilePagePresentation(kind, mobile) {
  const element = document.getElementById(MOBILE_PAGE_KINDS[kind]);
  const original = mobilePageState.originals.get(kind);
  if (!element || !original || element.classList.contains('is-mobile-page') === mobile) return;
  element.classList.toggle('is-mobile-page', mobile);
  if (mobile) {
    original.dialog.setAttribute('role', 'region');
    original.dialog.removeAttribute('aria-modal');
    original.dialog.setAttribute('aria-label', kind === 'album' ? 'Album details'
      : mobilePageState.pages.find(page => page.kind === kind)?.title || '');
    document.getElementById('mobile-page-outlet').appendChild(element);
  } else {
    for (const [name, value] of [['role', original.role], ['aria-modal', original.modal], ['aria-label', original.label]]) {
      if (value === null) original.dialog.removeAttribute(name);
      else original.dialog.setAttribute(name, value);
    }
    element.inert = false;
    original.placeholder.before(element);
  }
}
function writeMobilePageHistory(mode = 'push') {
  const url = new URL(window.location.href);
  const active = mobilePageState.pages.at(-1);
  if (active?.kind === 'non-album' && active.libraryWide) {
    url.pathname = '/loose-tracks';
    // Library-wide Loose Tracks never belong to the Artist tree selection.
    ['surface', 'artist', 'family_display'].forEach(key => url.searchParams.delete(key));
  } else if (url.pathname === '/loose-tracks') url.pathname = '/';
  ['mobile_page', 'mobile_album', 'utility_tab', 'loop_song', 'loop_filter', 'utility_detail', 'collection'].forEach(key => url.searchParams.delete(key));
  if (active) {
    if (active.kind !== 'non-album' || !active.libraryWide) url.searchParams.set('mobile_page', active.kind);
    if (active.albumKey) url.searchParams.set('mobile_album', active.albumKey);
    if (active.kind === 'non-album' && active.collectionName) url.searchParams.set('collection', active.collectionName);
    if (active.kind === 'utilities') {
      url.searchParams.set('utility_tab', active.tab || 'appearance');
      if (active.utilityDetail) url.searchParams.set('utility_detail', active.utilityDetail);
      if (active.tab === 'loops') {
        if (active.loopSongId) url.searchParams.set('loop_song', active.loopSongId);
        if (active.loopFilter) url.searchParams.set('loop_filter', active.loopFilter);
      }
    }
  }
  const snapshot = { ...(window.history.state || {}), mobilePages: mobilePageState.pages.map(page => ({ ...page })) };
  if (mode === 'replace') window.history.replaceState(snapshot, '', url);
  else if (window.AlbumHavenSettingsNavigation?.instance?.pushLibraryHistory) window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory(url.href, snapshot);
  else window.history.pushState(snapshot, '', url);
}
// Header Back follows the retained parent, while browser Forward keeps the child.
function resolveMobileParentPosition(descriptor, previous, snapshot = {}) {
  const restored = Array.isArray(snapshot.mobilePages)
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey) : null;
  const position = previous?.parentPosition ?? restored?.parentPosition ?? snapshot.albumHavenNavigationPosition;
  return Number.isSafeInteger(position) && position >= 0 ? position : null;
}
function mobileParentHistoryDelta(parentPosition, currentPosition) {
  return Number.isSafeInteger(parentPosition) && parentPosition >= 0
    && Number.isSafeInteger(currentPosition) && parentPosition < currentPosition
    ? parentPosition - currentPosition : null;
}
// Page history owns the viewport it came from. Resizing a hidden gallery can
// otherwise replace that position with the first visible row in another section.
function resolveMobileParentScrollPosition(descriptor, previous, snapshot = {}, scroll = null) {
  const restored = Array.isArray(snapshot.mobilePages)
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey) : null;
  const position = previous?.parentScrollPosition ?? restored?.parentScrollPosition ?? scroll;
  if (!position || !Number.isFinite(position.scrollTop) || !Number.isFinite(position.scrollLeft)) return null;
  return { scrollTop: Math.max(0, position.scrollTop), scrollLeft: Math.max(0, position.scrollLeft) };
}

function resolveMobileParentScrollAnchor(descriptor, previous, snapshot = {}, captured = null) {
  const restored = Array.isArray(snapshot.mobilePages)
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey)
    : null;
  const anchor = previous?.parentScrollAnchor ?? restored?.parentScrollAnchor ?? captured;
  if (!anchor || !Number.isFinite(anchor.scrollTop) || !Number.isFinite(anchor.scrollLeft)) return null;
  return {
    ...anchor,
    scrollTop: Math.max(0, anchor.scrollTop),
    scrollLeft: Math.max(0, anchor.scrollLeft),
  };
}
function resolveMobileParentViewUrl(descriptor, previous, snapshot = {}, viewUrl = '') {
  const restored = Array.isArray(snapshot.mobilePages)
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey) : null;
  return previous?.parentViewUrl ?? restored?.parentViewUrl ?? viewUrl;
}
function resolveMobileParentGalleryAnchorArtist(descriptor, previous, snapshot = {}, captured = '') {
  const restored = Array.isArray(snapshot.mobilePages)
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey) : null;
  return String(
    previous?.parentGalleryAnchorArtist ?? restored?.parentGalleryAnchorArtist ?? captured,
  ).trim();
}
function captureMobileParentGalleryAnchorArtist() {
 const requestedArtist = String(state.view?.gallery_page?.anchor_artist || '').trim();
 const renderedArtist = String(
 state.view?.gallery_page?.anchor_group_artist || requestedArtist,
 ).trim();
 if (!requestedArtist || !renderedArtist) return '';
 const scroll = document.getElementById('albums-scroll');
 const heading = [...document.querySelectorAll(
 '#artist-groups .family-artist-header[data-scroll-artist]',
 )].find(candidate => candidate.getAttribute('data-scroll-artist') === renderedArtist);
 const section = heading?.closest('.artist-section');
 const rows = section?.querySelector('.artist-rows');
 const firstCard = section?.querySelector('.album-card');
 if (!scroll || !rows || !firstCard) return '';
  const scrollTop = scroll.getBoundingClientRect().top + Number(scroll.clientTop || 0);
  return rows.getBoundingClientRect().top === scrollTop
    && firstCard.getBoundingClientRect().top >= scrollTop
 ? requestedArtist
 : '';
}
function mobileGalleryParentIsSettled() {
  return !state.busy && !state.ui?.pendingInventoryMutationViewRefresh
    && !state.ui?.activeViewRequestController && !state.ui?.pendingViewRequest;
}
function restoreMobileGalleryParent(descriptor) {
  const parentPosition = descriptor?.parentPosition;
  const destinationPosition = window.history?.state?.albumHavenNavigationPosition;
  const atParent = !Number.isSafeInteger(parentPosition) || !Number.isSafeInteger(destinationPosition)
    || parentPosition === destinationPosition;
  const galleryAnchorArtist = atParent
    ? String(descriptor?.parentGalleryAnchorArtist || '').trim()
    : '';
  const liveParent = descriptor && mobileLiveGalleryParents.get(descriptor);
  const canReuseLiveParent = atParent && liveParent && mobileGalleryParentIsSettled()
    && liveParent.revision === state.status?.inventory_mutation_revision
    && descriptor.parentViewUrl === buildUrl(state.view)
    && (
      typeof virtualGrid === 'undefined'
      || !virtualGrid?.hasDeferredMountedGroupUpdate?.()
    );
  let jumpScrollAnchor = null;
  if (
    galleryAnchorArtist
    && !descriptor?.parentScrollAnchor
    && typeof state !== 'undefined'
    && galleryAnchorArtist === String(state.view?.gallery_page?.anchor_artist || '').trim()
  ) {
    const mountedGalleryArtist = String(
      state.view?.gallery_page?.anchor_group_artist || galleryAnchorArtist,
    ).trim();
    if (
      typeof virtualGrid !== 'undefined'
      && virtualGrid?.scrollToArtist?.(mountedGalleryArtist)
    ) {
      stabilizeRootGalleryArtistAlignment(mountedGalleryArtist);
      if (canReuseLiveParent) {
        if (typeof updateGalleryMainChrome === 'function') updateGalleryMainChrome();
        return;
      }
      jumpScrollAnchor = virtualGrid?.captureScrollAnchor?.() || null;
    }
  }
  const semanticScrollAnchor = atParent
    ? descriptor?.parentScrollAnchor || jumpScrollAnchor
    : null;
  const position = semanticScrollAnchor
    ? null
    : atParent && !galleryAnchorArtist ? descriptor?.parentScrollPosition : null;
  const preserveParentScroll = !galleryAnchorArtist || Boolean(semanticScrollAnchor);
  const options = {
    preserveScroll: preserveParentScroll,
    preserveMountedGalleryChildren: preserveParentScroll,
  };
  // Root '/' can display the canonical album gallery as well as Home. Retain
  // the owning view route, not its data, through this page's history entry.
  if (atParent && descriptor?.parentViewUrl) options.parentViewUrl = descriptor.parentViewUrl;
  if (galleryAnchorArtist) {
    options.galleryAnchorArtist = galleryAnchorArtist;
  }
  if (semanticScrollAnchor) {
    options.semanticScrollAnchor = semanticScrollAnchor;
    const ownerGeneration = virtualGrid?.getUserScrollIntentGeneration?.();
    if (Number.isSafeInteger(ownerGeneration)) {
      options.semanticScrollOwnerGeneration = ownerGeneration;
    }
  }
  if (position) {
    options.preserveAbsoluteScroll = true;
    options.absoluteScrollPosition = position;
    // Restore before the request too: equivalent responses may retain the mounted
    // gallery. The virtual grid already owns stabilization and row materialization.
    if (typeof virtualGrid !== 'undefined' && virtualGrid?.restoreOwnedAbsoluteScrollPosition(position)) {
      options.absoluteScrollPositionApplied = true;
      virtualGrid.render(true);
    }
  }
  let semanticScrollPositionApplied = false;
  if (
    semanticScrollAnchor
    && typeof virtualGrid !== 'undefined'
    && typeof virtualGrid?.restoreOwnedScrollAnchor === 'function'
  ) {
    virtualGrid.render(true);
    virtualGrid.restoreOwnedScrollAnchor(semanticScrollAnchor);
    const ownerGeneration = options.semanticScrollOwnerGeneration;
    if (Number.isSafeInteger(ownerGeneration) && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (
          mobilePageState.pages.length
          || virtualGrid?.getUserScrollIntentGeneration?.() !== ownerGeneration
        ) return;
        virtualGrid.restoreOwnedScrollAnchor(semanticScrollAnchor);
        if (typeof updateGalleryMainChrome === 'function') updateGalleryMainChrome();
      });
    }
    semanticScrollPositionApplied = true;
  }
  if (
    canReuseLiveParent
    && (semanticScrollPositionApplied || (position && options.absoluteScrollPositionApplied))
  ) {
    if (typeof updateGalleryMainChrome === 'function') updateGalleryMainChrome();
    return;
  }
  handleGalleryBootstrapPopState(options);
}
function presentMobilePage(descriptor) {
  const historyOnly = descriptor.kind === 'non-album' && !usesMobilePageLayout();
  if (!usesMobilePageLayout() && !mobilePageState.pages.length && !historyOnly) return false;
  const outlet = document.getElementById('mobile-page-outlet');
  const element = document.getElementById(MOBILE_PAGE_KINDS[descriptor.kind]);
  if ((!outlet && !historyOnly) || !element) return false;
  const previous = mobilePageState.pages.find(page => page.kind === descriptor.kind);
  descriptor.parentPosition = resolveMobileParentPosition(descriptor, previous, window.history.state || {});
  descriptor.parentScrollPosition = resolveMobileParentScrollPosition(descriptor, previous, window.history.state || {},
    mobilePageState.pages.length ? null : document.getElementById('albums-scroll'));
  descriptor.parentScrollAnchor = resolveMobileParentScrollAnchor(
    descriptor,
    previous,
    window.history.state || {},
    mobilePageState.pages.length || typeof virtualGrid === 'undefined'
      ? null
      : virtualGrid?.captureScrollAnchor?.(),
  );
  descriptor.parentViewUrl = resolveMobileParentViewUrl(descriptor, previous, window.history.state || {},
    mobilePageState.pages[0]?.parentViewUrl || buildUrl(state.view));
  descriptor.parentGalleryAnchorArtist = resolveMobileParentGalleryAnchorArtist(
    descriptor,
    previous,
    window.history.state || {},
 mobilePageState.pages.length ? '' : captureMobileParentGalleryAnchorArtist(),
  );
  const active = mobilePageState.pages.at(-1);
  // Only a live, settled parent can be reused. History reconstruction must fetch.
  const inheritedParent = mobileLiveGalleryParents.get(previous || mobilePageState.pages[0] || {});
  if (!mobilePageState.restoring && inheritedParent) mobileLiveGalleryParents.set(descriptor, inheritedParent);
  else if (!mobilePageState.restoring && !mobilePageState.pages.length && mobileGalleryParentIsSettled()
    && Number.isSafeInteger(state.status?.inventory_mutation_revision)) {
    mobileLiveGalleryParents.set(descriptor, {
      view: state.view, groups: state.view?.artist_groups, revision: state.status.inventory_mutation_revision,
    });
  }
  // Registered before the same-page check: a history-only desktop page reaching phone width
  // must still move its surface into the outlet.
  if (!historyOnly && !mobilePageState.originals.has(descriptor.kind)) {
    const placeholder = document.createComment(`Original ${descriptor.kind} surface`);
    element.before(placeholder);
    const dialog = element.querySelector('[role="dialog"]') || element;
    mobilePageState.originals.set(descriptor.kind, { placeholder, dialog, role: dialog.getAttribute('role'),
      modal: dialog.getAttribute('aria-modal'), label: dialog.getAttribute('aria-label'), returnFocus: document.activeElement });
  }
  if (active?.kind === descriptor.kind && active.albumKey === descriptor.albumKey) {
    // Loose Tracks pages share one surface; each collection is still its own route.
    const routeChanged = active.kind === 'non-album'
      && (active.libraryWide !== descriptor.libraryWide || active.collectionName !== descriptor.collectionName);
    Object.assign(active, descriptor);
    syncMobilePageShell();
    if (routeChanged && !mobilePageState.restoring) writeMobilePageHistory('push');
    return true;
  }
  if (!historyOnly) delete outlet.dataset.pageInteracted;
  // A changed album reuses one component; older history entries retain its key for Back/Forward.
  const previousIndex = mobilePageState.pages.findIndex(page => page.kind === descriptor.kind);
  if (previousIndex >= 0) {
    // Returning to an existing page (for example from player artwork) must retire
    // all intervening surfaces. Dropping descriptors alone leaves orphaned UI visible.
    const retired = mobilePageState.pages.splice(previousIndex + 1);
    retired.reverse().forEach(cleanupMobilePage);
    mobilePageState.pages.splice(previousIndex, 1);
  }
  mobilePageState.pages.push(descriptor);
  closeArtistsDrawer({ restoreFocus: false });
  closeGalleryMainSurface?.(false);
  syncMobilePageShell();
  if (!mobilePageState.restoring) writeMobilePageHistory();
  if (!historyOnly) requestAnimationFrame(() => {
    const inBody = document.getElementById('mobile-page-header')?.dataset.albumIdentityInBody === 'true';
    const title = document.getElementById(inBody ? 'mobile-album-identity-title' : 'mobile-page-title');
    if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
  });
  return true;
}
function presentMobileAlbumPage(album) { return presentMobilePage(mobilePageDescriptor('album', album)); }
function presentMobileUtilityPage() { return presentMobilePage(mobilePageDescriptor('utilities')); }
function presentMobileCoverLookupPage(album) { return presentMobilePage(mobilePageDescriptor('cover-lookup', album)); }

function cleanupMobilePage(descriptor) {
  const element = document.getElementById(MOBILE_PAGE_KINDS[descriptor.kind]);
  const original = mobilePageState.originals.get(descriptor.kind);
  mobilePageState.cleaning = true;
  try {
    if (descriptor.kind === 'album') closeTrackModal();
    else if (descriptor.kind === 'utilities') closeUtilityModal(true);
    else if (descriptor.kind === 'cover-lookup') closeCoverLookupModal();
    else if (descriptor.kind === 'non-album') closeNonAlbumModal();
  } finally { mobilePageState.cleaning = false; }
  if (element && original) {
    setMobilePagePresentation(descriptor.kind, false);
    original.placeholder.replaceWith(element);
    mobilePageState.originals.delete(descriptor.kind);
  }
  if (descriptor.kind === 'album' && state.coverLookup?.returnToDrawerAfterAlbumDetails) {
    state.coverLookup.returnToDrawerAfterAlbumDetails = false;
    state.coverLookup.drawerOpen = true;
    renderCoverLookupDrawer();
    restoreCoverLookupDrawerScroll();
  }
  return original?.returnFocus;
}
function dismissMobilePage(kind) {
  if (mobilePageState.cleaning || !mobilePageState.pages.some(page => page.kind === kind)) return false;
  const index = mobilePageState.pages.findIndex(page => page.kind === kind);
  const delta = mobileParentHistoryDelta(mobilePageState.pages[index].parentPosition,
    window.history.state?.albumHavenNavigationPosition);
  if (delta !== null) {
    // Popstate retires the surface only after the traversal commits. This also
    // keeps Forward usable, instead of overwriting the album's history entry.
    window.history.go(delta);
    return true;
  }
  const retired = mobilePageState.pages.splice(index).reverse();
  let focus;
  retired.forEach(descriptor => { focus = cleanupMobilePage(descriptor); });
  writeMobilePageHistory('replace');
  syncMobilePageShell();
  if (!mobilePageState.pages.length) restoreMobileGalleryParent(retired.at(-1));
  // Returning to the gallery should not leave the originating artbox visibly
  // selected after a pointer/back navigation.
  if (focus?.isConnected) focus.blur();
  return true;
}
function navigateMobileBack() {
  const active = mobilePageState.pages.at(-1);
  if (!active) return;
  if (active.utilityDetail) {
    const delta = mobileParentHistoryDelta(active.utilityListPosition, window.history.state?.albumHavenNavigationPosition);
    if (delta !== null) window.history.go(delta);
    else { active.utilityDetail = ''; renderUtilityModalContent(); }
    return;
  }
  if (getMobileLoopPage()?.loopSongId) { returnMobileLoopList(); return; }
  // Keep the Appearance editor's unsaved-changes guard on both its close button and Back.
  if (active.kind === 'utilities') closeUtilityModal();
  else if (active.kind === 'album') closeTrackModal();
  else if (active.kind === 'non-album') closeNonAlbumModal();
  else closeCoverLookupModal();
}
function restoreMobilePage(descriptor) {
  if (!descriptor || !Object.hasOwn(MOBILE_PAGE_KINDS, descriptor.kind)) return;
  const album = descriptor.albumKey ? (getIndexedAlbum(descriptor.albumKey) || { key: descriptor.albumKey, name: descriptor.title || 'Album', preview_only: true }) : null;
  if (descriptor.kind === 'non-album') openNonAlbumModal({
    libraryWide: descriptor.libraryWide === true,
    collectionName: descriptor.collectionName || '',
    navigationSource: descriptor.navigationSource,
  });
  else if (descriptor.kind === 'album' && album) openTrackModal(album);
  else if (descriptor.kind === 'utilities') {
    setUtilityActiveTab(mobileUtilityTabAllowed(descriptor.tab) ? descriptor.tab : 'appearance');
    if (state.utility.activeTab === 'loops') state.utility.loopsSearchQuery = String(descriptor.loopFilter || '');
    openUtilityModal();
    const page = mobilePageState.pages.find(item => item.kind === 'utilities');
    if (page && ['log-history', 'problematic-files'].includes(state.utility.activeTab)) {
      page.utilityDetail = String(descriptor.utilityDetail || '');
      page.utilityListPosition = descriptor.utilityListPosition ?? null;
      if (page.utilityDetail && state.utility.activeTab === 'problematic-files') state.utility.selectedProblematicKey = page.utilityDetail;
      if (page.utilityDetail && state.utility.activeTab === 'log-history') void selectUtilityLogHistoryEvent(page.utilityDetail).catch(error => showToast(error.message || 'Unable to load log history.', 'error', 3200));
      renderUtilityModalContent();
    }
    if (page && state.utility.activeTab === 'loops') {
      Object.assign(page, { loopSongId: String(descriptor.loopSongId || ''), loopFilter: String(descriptor.loopFilter || ''),
        loopListPosition: descriptor.loopListPosition ?? null, loopListScroll: Number(descriptor.loopListScroll) || 0,
        restoreLoopScroll: !descriptor.loopSongId });
      renderUtilityModalContent();
    }
  } else if (descriptor.kind === 'cover-lookup' && album) void openCoverLookupModal(album);
}

function restoreMobilePageFromUrl() {
  const url = new URL(window.location.href);
  const looseTracksPath = url.pathname === '/loose-tracks';
  const kind = url.searchParams.get('mobile_page') || (looseTracksPath ? 'non-album' : '');
  if (!kind || (!usesMobilePageLayout() && kind !== 'non-album')) return;
  mobilePageState.restoring = true;
  try {
    restoreMobilePage({
      kind,
      albumKey: url.searchParams.get('mobile_album') || '',
      title: 'Album',
      libraryWide: looseTracksPath,
      collectionName: url.searchParams.get('collection') || '',
      navigationSource: looseTracksPath ? 'library-tree' : 'artist',
      tab: url.searchParams.get('utility_tab'),
      utilityDetail: url.searchParams.get('utility_detail') || '',
      loopSongId: url.searchParams.get('loop_song') || '',
      loopFilter: url.searchParams.get('loop_filter') || '',
    });
    // Opening the page moves the side bar to its tree (syncLibraryNavigationToMainPanel).
  } finally {
    mobilePageState.restoring = false;
  }
  writeMobilePageHistory('replace');
}

// Whether a history entry's page is the page already shown. Loose Tracks pages have no album key: their scope and
// collection tell them apart (audit 2026-11-18: Back between two collections kept the second one on screen).
function isSameMobilePage(requested, current) {
  if (requested.kind !== current.kind || requested.albumKey !== current.albumKey) return false;
  if (requested.kind === 'utilities') {
    return requested.tab === current.tab
      && String(requested.utilityDetail || '') === String(current.utilityDetail || '')
      && String(requested.loopSongId || '') === String(current.loopSongId || '');
  }
  if (requested.kind === 'non-album') {
    return Boolean(requested.libraryWide) === Boolean(current.libraryWide)
      && String(requested.collectionName || '') === String(current.collectionName || '');
  }
  return true;
}
function handleMobilePagePopState() {
  const requested = Array.isArray(window.history.state?.mobilePages) ? window.history.state.mobilePages : [];
  const hadPage = mobilePageState.pages.length > 0;
  if (!hadPage && !requested.length) return false;
  let common = 0;
  while (common < requested.length && common < mobilePageState.pages.length
    && isSameMobilePage(requested[common], mobilePageState.pages[common])) common += 1;
  const parent = mobilePageState.pages[0];
  let focus;
  // Closing the old pages and opening the requested ones is one step for the side bar: it syncs once, after.
  mobilePageState.restoring = true;
  try {
    while (mobilePageState.pages.length > common) focus = cleanupMobilePage(mobilePageState.pages.pop());
    requested.slice(common).forEach(restoreMobilePage);
  } finally { mobilePageState.restoring = false; }
  if (typeof syncLibraryNavigationAfterPageChange === 'function') syncLibraryNavigationAfterPageChange();
  if (mobilePageState.pages.length < requested.length) writeMobilePageHistory('replace');
  syncMobilePageShell();
  // A background refresh may have replaced the gallery while its child was open.
  // Restore the retained parent URL through the normal gallery request owner.
  if (!requested.length) restoreMobileGalleryParent(parent);
  if (!requested.length && focus?.isConnected) requestAnimationFrame(() => focus.blur());
  return true;
}
function syncMobileUtilityContext() {
  const descriptor = mobilePageState.pages.find(page => page.kind === 'utilities');
  if (!descriptor) return;
  if (descriptor.tab !== state.utility.activeTab) {
    document.getElementById('mobile-page-outlet').scrollTop = 0;
    delete descriptor.utilityDetail;
    delete descriptor.utilityListPosition;
    delete descriptor.loopSongId;
    delete descriptor.loopListPosition;
    delete descriptor.loopListScroll;
  }
  descriptor.tab = state.utility.activeTab;
  const group = resolveMobileLoopSongGroup(descriptor, state.utility.loops || []);
  const song = group?.representativeLoop || group?.loops[0];
  descriptor.title = song ? song.title || song.name || 'Saved loops'
    : MOBILE_UTILITY_SECTIONS[state.utility.activeTab]?.label || 'Settings';
  descriptor.subtitle = song ? [song.artist || 'Unknown artist', song.album, song.year].filter(Boolean).join(' • ') : '';
  descriptor.loopCount = song ? `${group.loops.length} saved loop${group.loops.length === 1 ? '' : 's'}` : '';
  if (descriptor.tab === 'loops') descriptor.loopFilter = String(state.utility.loopsSearchQuery || '');
  syncMobilePageShell();
  syncMobileUtilityNavigation();
  syncMobileUtilityDetail();
  if (!mobilePageState.restoring) writeMobilePageHistory('replace');
}
// Loops uses the existing tree as its mobile index, not a second data source.
// Only an explicit song activation enters detail; desktop auto-selection is separate.
function getMobileLoopPage() {
  const page = mobilePageState.pages.at(-1);
  return usesMobilePageLayout() && page?.kind === 'utilities' && state.utility.activeTab === 'loops' ? page : null;
}
function resolveMobileLoopSongGroup(page, loops) {
  if (page?.tab !== 'loops' || !page.loopSongId) return null;
  const songLoop = loops.find(loop => String(loop.id) === String(page.loopSongId));
  if (!songLoop) return null;
  const key = buildUtilityLoopGroupKey(songLoop);
  return groupUtilityLoops(loops).find(group => String(group.key) === String(key)) || null;
}
function openMobileLoopSong(groupKey) {
  const page = getMobileLoopPage();
  const group = groupUtilityLoops(state.utility.loops || []).find(item => String(item.key) === String(groupKey));
  if (!page || !group?.loops.length) return false;
  if (page.loopSongId) return true;
  const outlet = document.getElementById('mobile-page-outlet');
  page.loopFilter = String(state.utility.loopsSearchQuery || '');
  page.loopListScroll = outlet.scrollTop;
  page.loopListPosition = window.history.state?.albumHavenNavigationPosition ?? null;
  writeMobilePageHistory('replace');
  page.loopSongId = String(group.loops[0].id);
  state.utility.selectedLoopGroupKey = String(group.key);
  state.utility.selectedLoopId = page.loopSongId;
  closeGalleryMainSurface(false);
  const wasRestoring = mobilePageState.restoring;
  mobilePageState.restoring = true;
  try { renderUtilityModalContent(); }
  finally { mobilePageState.restoring = wasRestoring; }
  writeMobilePageHistory();
  outlet.scrollTop = 0;
  document.getElementById('mobile-page-title')?.focus({ preventScroll: true });
  return true;
}
function returnMobileLoopList() {
  const page = getMobileLoopPage();
  if (!page?.loopSongId) return false;
  const delta = mobileParentHistoryDelta(page.loopListPosition, window.history.state?.albumHavenNavigationPosition);
  if (delta !== null) { window.history.go(delta); return true; }
  // A directly loaded song has no in-app previous entry. Back still goes to Loops.
  page.loopSongId = '';
  page.restoreLoopScroll = true;
  renderUtilityModalContent();
  return true;
}
function restoreMobileLoopListScroll(page) {
  if (!page?.restoreLoopScroll || state.utility.loopsLoading) return;
  delete page.restoreLoopScroll;
  requestAnimationFrame(() => {
    if (getMobileLoopPage() !== page || page.loopSongId) return;
    document.getElementById('mobile-page-outlet').scrollTop = Number(page.loopListScroll) || 0;
  });
}
function syncMobileLoopHeader() {
  const header = document.getElementById('mobile-page-header');
  if (!header) return;
  const group = resolveMobileLoopSongGroup(getMobileLoopPage(), state.utility.loops || []);
  header.dataset.loopSong = String(Boolean(group));
  let cover = document.getElementById('mobile-loop-page-cover');
  if (!group) { if (cover) cover.hidden = true; return; }
  if (!cover) {
    cover = document.createElement('div');
    cover.id = 'mobile-loop-page-cover';
    cover.className = 'utility-detail-cover utility-loop-sticky-cover mobile-loop-page-cover';
    header.querySelector('.gallery-bar__context').before(cover);
  }
  const song = group.representativeLoop || group.loops[0];
  const markup = buildUtilityAlbumArtbox(song, { label: `Artwork for ${song.title || song.name || 'loop'}`, interactive: false });
  if (cover.innerHTML !== markup) cover.innerHTML = markup;
  cover.hidden = false;
}

function syncMobileGalleryControls() {
  const savedColumns = window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 3);
  const columns = [1, 2, 3].includes(savedColumns) ? savedColumns : 3;
  document.documentElement.style.setProperty('--mobile-gallery-columns', String(columns));

}
function prepareMobileGalleryNavigation() {
  if (!mobilePageState.pages.length) return false;
  while (mobilePageState.pages.length) cleanupMobilePage(mobilePageState.pages.pop());
  syncMobilePageShell();
  return true;
}
function prepareMobileGallerySearch(onConfirmed, skipAppearanceGuard = false) {
  if (!mobilePageState.pages.length) return true;
  if (!skipAppearanceGuard && mobilePageState.pages.some(page => page.kind === 'utilities')
    && typeof confirmBackgroundAppearanceLeave === 'function'
    && !confirmBackgroundAppearanceLeave(onConfirmed)) return false;
  prepareMobileGalleryNavigation();
  // Keep the page behind the new search entry available through browser Back.
  writeMobilePageHistory();
  return true;
}
// The badge is a projection of the existing input, never a second query store.
function syncMobileSearchQueryIndicator() {
  const button = document.getElementById('mobile-search-button');
  if (!button) return;
  const hasQuery = Boolean(String(document.getElementById('search-input')?.value || '').trim());
  button.setAttribute('data-has-query', String(hasQuery));
  if (hasQuery && usesMobilePageLayout()) button.setAttribute('aria-description', 'Search query present');
  else button.removeAttribute('aria-description');
}
function handleMobileSearchOutsideClick(event) {
  if (!usesMobilePageLayout() || !mobilePageState.searchOpen) return;
  if (document.getElementById('search-form')?.contains(event.target)
    || document.getElementById('recent-search-popover')?.contains(event.target)) return;
  // Capture dismissal without cancelling the same tap's Settings/page action.
  setMobileSearchOpen(false);
}
function setMobileSearchOpen(open) {
  mobilePageState.searchSuggestionsReady = false;
  if (typeof closeRecentSearchPopover === 'function') closeRecentSearchPopover();
  if (open) {
    const form = document.getElementById('search-form');
    document.dispatchEvent(new CustomEvent('album-haven:surface-opening', { detail: { surface: form } }));
  }
  mobilePageState.searchOpen = Boolean(open);
  const form = document.getElementById('search-form');
  const nav = document.getElementById('mobile-navigation');
  nav?.classList.toggle('is-search-open', Boolean(open));
  form?.closest('.app-bar')?.classList.toggle('is-search-open', Boolean(open));
  document.getElementById('mobile-search-button')?.setAttribute('aria-expanded', String(Boolean(open)));
  const input = document.getElementById('search-input');
  if (input && usesMobilePageLayout()) {
    if (!open && document.activeElement === input) input.blur();
    input.inert = !open;
    input.setAttribute('aria-hidden', String(!open));
  }
  syncMobileSearchQueryIndicator();
  if (open) input?.focus();
}
function handleMobileSearchSubmit() {
  if (!usesMobilePageLayout()) return false;
  if (!mobilePageState.searchOpen) { setMobileSearchOpen(true); return true; }
  if (!String(document.getElementById('search-input')?.value || '').trim()) {
    setMobileSearchOpen(false);
  }
  return false;
}
function hasActiveMobilePage() { return mobilePageState.pages.length > 0; }
function promoteVisibleMobileDialogs() {
  if (!usesMobilePageLayout()) return;
  const kinds = ['album', 'non-album', 'utilities', 'cover-lookup'];
  if (document.getElementById('track-modal')?.classList.contains('is-above-settings')) {
    kinds.splice(kinds.indexOf('album'), 1);
    kinds.splice(kinds.indexOf('cover-lookup'), 0, 'album');
  }
  // Capture visibility before moving surfaces: presenting a child hides its parent.
  const visible = kinds.filter(kind => {
    const element = document.getElementById(MOBILE_PAGE_KINDS[kind]);
    return element
      && !element.hidden
      && !(kind === 'cover-lookup' && element.classList.contains('is-mobile-sheet'))
      && !mobilePageState.originals.has(kind);
  });
  for (const kind of visible) {
    if (kind === 'utilities' && !mobileUtilityTabAllowed(state.utility.activeTab)) {
      setUtilityActiveTab('appearance');
      void loadActiveUtilityTab();
    }
    const album = kind === 'album' ? getCurrentTrackModalAlbum()
      : kind === 'cover-lookup' ? state.coverLookup.modal.album : null;
    // A desktop Loose Tracks page already has a history-only route; promotion keeps it.
    const route = kind === 'non-album' ? mobilePageState.pages.find(page => page.kind === kind) : null;
    presentMobilePage(route
      ? { ...mobilePageDescriptor(kind, album, route), title: route.title, subtitle: route.subtitle }
      : mobilePageDescriptor(kind, album));
    if (kind === 'utilities') renderUtilityModalContent();
  }
}

// Owner 2026-11-17: the browser tab names what is on screen and follows every navigation: the open page
// (Cover Look Up, Album Details, Settings, a collection), else the gallery's artist or search, else the app.
function currentAlbumHavenPageTitle() {
  const active = usesMobilePageLayout() ? mobilePageState.pages.at(-1) : null;
  if (active) return active.title;
  const open = id => document.getElementById(id)?.hidden === false;
  if (open('cover-lookup-modal')) return 'Cover Art Look Up';
  if (open('track-modal')) {
    const album = typeof getCurrentTrackModalAlbum === 'function' ? getCurrentTrackModalAlbum() : null;
    return String(album?.display_name || album?.name || 'Album');
  }
  if (open('utility-modal')) return 'Settings';
  if (open('non-album-modal')) return String(state.ui?.nonAlbumCollectionName || '').trim() || 'Loose Tracks';
  const query = String(state.view?.query || '').trim();
  if (query) return `Search: ${query}`;
  return String(state.view?.selected_artist || '').trim();
}

function syncAlbumHavenDocumentTitle() {
  if (typeof document === 'undefined') return;
  const title = currentAlbumHavenPageTitle();
  const next = title ? `${title} — Album Haven` : albumHavenBaseDocumentTitle;
  if (next && document.title !== next) document.title = next;
}

// Desktop pages open and close by toggling `hidden`; one observer keeps the tab title in step with all of them.
function installAlbumHavenDocumentTitleSync() {
  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(() => syncAlbumHavenDocumentTitle());
  ['cover-lookup-modal', 'track-modal', 'utility-modal', 'non-album-modal'].forEach((id) => {
    const element = document.getElementById(id);
    if (element) observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
  });
  syncAlbumHavenDocumentTitle();
}

function initMobileNavigation() {
  if (mobilePageState.initialized || !document.getElementById('mobile-navigation')) return;
  mobilePageState.initialized = true;
  installAlbumHavenDocumentTitleSync();
  const form = document.getElementById('search-form');
  const submit = form?.querySelector('[data-search-submit]');
  if (submit) { submit.id = 'mobile-search-button'; submit.setAttribute('aria-controls', 'search-input'); }
  const placeholder = document.createComment('Desktop search position');
  form?.before(placeholder);
  const syncLayout = () => {
    const mobile = usesMobilePageLayout();
    document.documentElement.dataset.clientProfile = window.AlbumHavenDevicePreferences?.profile() || (isMobileClient() ? 'mobile' : 'web_desktop');
    if (form) {
      if (mobile) document.querySelector('.app-bar-brand')?.after(form);
      else {
        placeholder.after(form);
        const input = document.getElementById('search-input');
        if (input) { input.inert = false; input.removeAttribute('aria-hidden'); }
        submit?.removeAttribute('aria-expanded');
      }
      if (mobile) setMobileSearchOpen(mobilePageState.searchOpen);
      else syncMobileSearchQueryIndicator();
    }
    promoteVisibleMobileDialogs();
    syncMobileGalleryControls();
    syncMobilePageShell();
    const coverLookup = document.getElementById('cover-lookup-modal');
    if (coverLookup && !coverLookup.hidden) renderCoverLookupModal();
    if (['loops', 'integrations', 'log-history', 'problematic-files'].includes(state.utility.activeTab) && mobilePageState.pages.some(page => page.kind === 'utilities')) renderUtilityModalContent();
    if (typeof syncMobileAlbumComposition === 'function') syncMobileAlbumComposition(getCurrentTrackModalAlbum());
  };
  const pageOutlet = document.getElementById('mobile-page-outlet');
  pageOutlet?.addEventListener('scroll', scheduleMobileAlbumThumbnail, { passive: true });
  const showPageScrollbar = event => {
    if (!event.isTrusted || !usesMobilePageLayout() || mobilePageState.pages.at(-1)?.kind !== 'album') return;
    if (event.type === 'keydown' && !['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return;
    pageOutlet.dataset.pageInteracted = 'true';
  };
  for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown']) {
    pageOutlet?.addEventListener(type, showPageScrollbar, { passive: true, capture: true });
  }
  window.addEventListener('resize', scheduleMobileAlbumThumbnail, { passive: true });
  syncLayout();
  initMobileGalleryPinch();
  const searchResize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const active = galleryMainSurfaceController?.current?.();
    if (active?.key === 'search-suggestions') positionSearchSuggestionsSurface(active.surface);
  }) : null;
  if (form) searchResize?.observe(form);
  window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
    if (galleryMainSurfaceController?.current?.()?.surface?.matches?.('.artist-info-overlay')) closeGalleryMainSurface(false);
    const saved = window.AlbumHavenDevicePreferences?.read('galleryDisplayPreferences', null);
    if (saved) {
      state.gallery.displayPreferences = saved;
      ensureGalleryMainState().view = normalizeGalleryView(saved.defaultGalleryDisplayMode);
      state.view.gallery_display_mode = normalizeGalleryView(saved.defaultGalleryDisplayMode);
    }
    syncLayout();
    syncMobileHome();
    if (virtualGrid) { virtualGrid.lastKey = ''; virtualGrid.recalculate(); }
    renderArtistGroups({ preserveScroll: true });
    restorePlayerAppearance();
    updatePlayerUi();
    if (typeof renderMobileHome === 'function') renderMobileHome();
  });
  document.addEventListener('click', handleMobileSearchOutsideClick, true);
  document.addEventListener('click', (event) => {
    if (handleMobileSettingsClick(event)) return;
    if (event.target.closest?.('[data-mobile-back]')) navigateMobileBack();

  });
  // Enforce presentation restrictions at all delegated mobile action entry points.
  document.addEventListener('click', (event) => {
    if (!isMobileClient()) return;
    if (event.target.closest?.('[data-open-track-modal-duplicate-folder], [data-open-problematic-album-folder], [data-open-non-album-tag-editor], [data-open-tag-editor], [data-edit-tags], [data-edit-album-tags], [data-edit-track-tags], [data-revert-version-exception], [data-revert-problem-ignore], [data-delete-saved-loop]')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    const dialog = document.querySelector('.is-mobile-artist-dialog[aria-modal="true"]');
    if (dialog && event.key === 'Tab') {
      const items = [...dialog.querySelectorAll('button:not([disabled]), a[href]')].filter(node => node.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.key === 'Escape' && usesMobilePageLayout() && mobilePageState.searchOpen && form?.contains(event.target)) {
      event.preventDefault(); setMobileSearchOpen(false); document.getElementById('mobile-search-button')?.focus(); return;
    }
    const settingsOpen = galleryMainSurfaceController?.current?.()?.key === 'mobile-settings';
    const rail = document.getElementById(settingsOpen ? 'mobile-settings-drawer' : 'shell-navigation-rail');
    if (event.key === 'Tab' && (settingsOpen || state.ui.artistsDrawerOpen) && usesMobilePageLayout()) {
      const focusable = [...rail.querySelectorAll('button:not([disabled]), a[href], input:not([disabled])')].filter(node => !node.closest('[hidden], [inert]') && node.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !rail.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !rail.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  });
  document.addEventListener('album-haven:preferences-sync', (event) => {
    let status = document.getElementById('mobile-preference-status');
    if (!status) { status = document.createElement('p'); status.id = 'mobile-preference-status'; status.className = 'mobile-preference-status'; status.setAttribute('role', 'status'); document.body.appendChild(status); }
    status.hidden = !['unsaved', 'unavailable'].includes(event.detail.state);
    status.textContent = 'Settings have not synced. They will retry when you reconnect.';
  });
  restoreMobilePageFromUrl();
}


const MOBILE_UTILITY_SECTIONS = Object.freeze({
  'problematic-files': { label: 'Problematic Files', action: 'library.problems.read' },
  rules: { label: 'Rules', action: 'library.rules.read' },
  loops: { label: 'Loops', action: 'library.loops.read' },
  'log-history': { label: 'Log History', action: 'library.logs.read' },
  integrations: { label: 'Integrations', action: 'integration.settings.read' },
  appearance: { label: 'Appearance', action: null },
  android: { label: 'Android app', action: null },
});
function mobileUtilityTabAllowed(tab, actions = window.__ALBUM_HAVEN_UTILITY_ALLOWED_ACTIONS__ || {}) {
  if (tab === 'android' && !(typeof isAndroidShell === 'function' && isAndroidShell())) return false;
  const section = Object.hasOwn(MOBILE_UTILITY_SECTIONS, tab) ? MOBILE_UTILITY_SECTIONS[tab] : null;
  return Boolean(section && (!section.action || actions[section.action] === true));
}
function mobileUtilitySubsectionAttribute(tab = state.utility.activeTab) {
  return ({ android: 'data-utility-android-key', appearance: 'data-utility-appearance-key', integrations: 'data-utility-integration-key', rules: 'data-utility-rule-key' })[tab] || '';
}
function mobileUtilitySubsections() {
  const list = getUtilityModalElements().list;
  const attribute = mobileUtilitySubsectionAttribute();
  if (!attribute) return [];
  const selected = state.utility.activeTab === 'android' ? 'updates'
    : state.utility.activeTab === 'appearance' ? state.utility.appearanceKey
    : state.utility.activeTab === 'rules' ? state.utility.selectedRuleKey : state.utility.selectedIntegrationKey;
  return [...(list?.querySelectorAll(`[${attribute}]`) || [])].map(node => ({
    key: node.getAttribute(attribute),
    label: node.getAttribute(attribute) === 'lastfm' ? 'Scrobbling'
      : (node.querySelector('.utility-list-item-title, .navigation-tree__label') || node).textContent.trim(),
    selected: node.getAttribute(attribute) === selected,
  })).filter(item => state.utility.activeTab !== 'integrations' || item.key !== 'library'
    || window.__ALBUM_HAVEN_UTILITY_ALLOWED_ACTIONS__?.['library.settings.read'] === true);
}
function syncMobileUtilityNavigation() {
  const list = document.querySelector('[data-mobile-settings-list]');
  if (!list) return;
  const allowed = Object.entries(MOBILE_UTILITY_SECTIONS).filter(([key]) => mobileUtilityTabAllowed(key));
  const signature = JSON.stringify([allowed, state.utility.activeTab]);
  if (list.dataset.renderKey !== signature) {
    list.innerHTML = allowed.map(([key, section]) => window.NavigationTree.renderItem({ key, label: section.label,
      variant: 'panel', action: true, selected: key === state.utility.activeTab,
      attributes: { 'data-mobile-settings-choice': key },
    })).join('');
    list.dataset.renderKey = signature;
  }
  const choices = mobileUtilitySubsections();
  const trigger = document.getElementById('mobile-settings-section-button');
  const menu = document.getElementById('mobile-settings-subsection-menu');
  trigger.hidden = !choices.length && state.utility.activeTab !== 'rules';
  trigger.querySelector('[data-mobile-subsection-label]').textContent = choices.find(item => item.selected)?.label || (state.utility.activeTab === 'rules' ? 'Rules' : 'Sections');
  const menuSignature = JSON.stringify(choices);
  if (menu.dataset.renderKey !== menuSignature) {
    menu.innerHTML = choices.map(item => `<button class="gallery-menu-action" type="button" data-mobile-subsection="${escapeHtml(item.key)}" aria-pressed="${item.selected}">${escapeHtml(item.label)}</button>`).join('');
    if (state.utility.activeTab === 'rules') {
      menu.innerHTML = choices.length ? choices.map(item => window.NavigationTree.renderItem({ key: item.key, label: item.label, action: true, variant: 'panel', selected: item.selected, attributes: { 'data-mobile-subsection': item.key } })).join('') : '<p class="utility-empty-state compact">No rules found.</p>';
    }
    menu.dataset.renderKey = menuSignature;
  }
}
function handleMobileSettingsClick(event) {
  const target = event.target;
  const trigger = target.closest?.('[data-mobile-settings-menu]');
  if (trigger) { event.preventDefault(); closeArtistsDrawer({ restoreFocus: false }); syncMobileUtilityNavigation(); openGalleryMainSurface('mobile-settings', trigger, document.getElementById('mobile-settings-drawer'), 'left'); return true; }
  if (target.closest?.('[data-close-mobile-settings]')) { event.preventDefault(); closeGalleryMainSurface(true); return true; }
  const category = target.closest?.('[data-mobile-settings-choice]');
  if (category) {
    event.preventDefault();
    const key = category.dataset.mobileSettingsChoice;
    if (mobileUtilityTabAllowed(key)) {
      closeGalleryMainSurface(false);
      // The original tab's action owns data loading, draft guards, and selection.
      const selected = setUtilityActiveTab(key);
      if (selected === key) { void loadActiveUtilityTab(); renderUtilityModalContent(); }
    }
    return true;
  }
  const subsections = target.closest?.('[data-mobile-settings-subsections]');
  if (subsections) { event.preventDefault(); openGalleryMainSurface('settings-subsection', subsections, document.getElementById('mobile-settings-subsection-menu')); return true; }
  const choice = target.closest?.('[data-mobile-subsection]');
  if (choice) {
    event.preventDefault();
    if (mobileUtilitySubsections().some(item => item.key === choice.dataset.mobileSubsection)) {
      closeGalleryMainSurface(false);
      const attribute = mobileUtilitySubsectionAttribute();
      [...getUtilityModalElements().list.querySelectorAll(`[${attribute}]`)].find(node => node.getAttribute(attribute) === choice.dataset.mobileSubsection)?.click();
    }
    return true;
  }
  return false;
}
function syncMobileAlbumHeader() {
  const header = document.getElementById('mobile-page-header');
  const context = header?.querySelector('.gallery-bar__context');
  const thumbnail = document.getElementById('mobile-page-cover');
  const collectionAdd = document.getElementById('mobile-page-collection-artwork');
  if (!header || !context || !thumbnail || !collectionAdd) return;
  const active = mobilePageState.pages.at(-1);
  const outlet = document.getElementById('mobile-page-outlet');
  const cover = document.getElementById('track-modal-cover');
  const identity = document.querySelector('#track-modal .mobile-album-identity');
  const albumPage = active?.kind === 'album' && usesMobilePageLayout();
  const collectionPage = active?.kind === 'non-album'
    && Boolean(active.collectionName)
    && usesMobilePageLayout();
  const collectionArtwork = collectionPage
    ? state.ui?.customCollectionArtworkByName?.[active.collectionName] || null
    : null;
  const collectionCoverSrc = String(collectionArtwork?.image_url || '').trim();
  const collectionBodyCover = collectionPage
    ? document.querySelector('.custom-collection-detail__art:not([hidden])')
    : null;
  const hasInlineIdentity = albumPage && identity && !identity.hidden;
  const presentation = resolveMobileAlbumHeaderState({
    albumPage: albumPage || Boolean(collectionPage && collectionCoverSrc),
    hasInlineIdentity,
    hasCover: albumPage ? Boolean(active?.coverSrc) : Boolean(collectionCoverSrc),
    viewportTop: outlet?.getBoundingClientRect().top,
    coverBottom: albumPage
      ? cover?.getBoundingClientRect().bottom
      : collectionBodyCover?.getBoundingClientRect().bottom,
    identityBottom: hasInlineIdentity ? identity.getBoundingClientRect().bottom : undefined,
  });
  header.dataset.inlineAlbumLayout = String(Boolean(hasInlineIdentity));
  header.dataset.albumIdentityInBody = String(presentation.bodyOwnsIdentity);
  // One Back button: beside the cover initially, in the pinned bar after handoff.
  const back = document.getElementById('mobile-back-button');
  const overview = document.querySelector('#track-modal .mobile-album-overview');
  const rail = overview?.querySelector(':scope > .mobile-album-overview__rail');
  const backHost = presentation.bodyOwnsIdentity && overview ? rail || overview : header;
  if (back && back.parentElement !== backHost) backHost.prepend(back);
  header.inert = presentation.bodyOwnsIdentity;
  if (presentation.bodyOwnsIdentity) header.setAttribute('aria-hidden', 'true');
  else header.removeAttribute('aria-hidden');
  context.inert = presentation.bodyOwnsIdentity;
  if (presentation.bodyOwnsIdentity) context.setAttribute('aria-hidden', 'true');
  else context.removeAttribute('aria-hidden');
  if (identity) {
    const deferToHeader = Boolean(hasInlineIdentity && !presentation.bodyOwnsIdentity);
    identity.inert = deferToHeader;
    if (deferToHeader) identity.setAttribute('aria-hidden', 'true');
    else identity.removeAttribute('aria-hidden');
  }
  const thumbnailSrc = albumPage ? active.coverSrc : collectionCoverSrc;
  thumbnail.hidden = !presentation.showCover;
  if (presentation.showCover && thumbnail.getAttribute('src') !== thumbnailSrc) thumbnail.src = thumbnailSrc;
  if (!albumPage && !collectionCoverSrc) thumbnail.removeAttribute('src');
  const showCollectionAdd = Boolean(collectionPage && !collectionCoverSrc);
  collectionAdd.hidden = !showCollectionAdd;
  if (showCollectionAdd && collectionAdd.dataset.collectionName !== active.collectionName) {
    collectionAdd.dataset.collectionName = active.collectionName;
    collectionAdd.innerHTML = buildCustomCollectionArtworkMarkup(active.collectionName);
  } else if (!showCollectionAdd) {
    collectionAdd.replaceChildren();
    delete collectionAdd.dataset.collectionName;
  }
}

let mobileAlbumThumbnailFrame = 0;
function scheduleMobileAlbumThumbnail() {
  if (mobileAlbumThumbnailFrame) return;
  mobileAlbumThumbnailFrame = requestAnimationFrame(() => {
    mobileAlbumThumbnailFrame = 0;
    syncMobileAlbumHeader();
  });
}

function returnMobilePagesToGallery() {
  while (mobilePageState.pages.length) cleanupMobilePage(mobilePageState.pages.pop());
  syncMobilePageShell();
  writeMobilePageHistory('replace');
  syncMobileHome();
}
if (typeof window !== 'undefined') window.AlbumHavenReturnToGallery = returnMobilePagesToGallery;

const mobileArtistInfoInert = new Map();
function syncMobileArtistInfoDialog(overlay, open) {
  const modal = Boolean(open && usesMobilePageLayout());
  overlay.classList.toggle('is-mobile-artist-dialog', modal);
  const backdrop = document.querySelector('.mobile-artist-info-backdrop');
  if (backdrop) backdrop.hidden = !modal;
  if (modal) {
    overlay.setAttribute('aria-modal', 'true');
    for (const node of document.querySelectorAll('#app-shell, [data-settings-host], .global-player')) {
      if (!mobileArtistInfoInert.has(node)) mobileArtistInfoInert.set(node, node.inert);
      node.inert = true;
    }
  } else {
    overlay.removeAttribute('aria-modal');
    for (const [node, inert] of mobileArtistInfoInert) node.inert = inert;
    mobileArtistInfoInert.clear();
  }
}

// A deliberate pinch changes density in stable 1/2/3-column steps. One finger
// remains native scrolling; browser magnification remains available outside Gallery.
function resolvePinchColumns(columns, scale) {
  const start = [1, 2, 3].includes(columns) ? columns : 3;
  if (!Number.isFinite(scale) || scale <= 0) return start;
  const steps = scale >= 1 ? Math.floor(Math.log(scale) / Math.log(1.28) + 1e-9)
    : -Math.floor(Math.log(1 / scale) / Math.log(1.28) + 1e-9);
  return Math.max(1, Math.min(3, start - steps));
}
function resolvePinchDensity(columns, scale) {
  const start = [1, 2, 3].includes(columns) ? columns : 3;
  if (!Number.isFinite(scale) || scale <= 0) return start;
  const travel = Math.log(scale) / Math.log(1.28);
  const magnitude = Math.abs(travel);
  // Half a cell at the first threshold, then one cell per threshold. The
  // release resolver above remains the authority for the persisted choice.
  const continuous = magnitude <= 1 ? magnitude / 2 : magnitude - 0.5;
  return Math.max(1, Math.min(3, start - Math.sign(travel) * continuous));
}
function setMobileGalleryColumns(columns, options = {}) {
  if (![1, 2, 3].includes(columns) || !usesMobilePageLayout()) return false;
  if (window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 3) === columns) return false;
  const anchor = options.anchor || (typeof virtualGrid !== 'undefined' ? virtualGrid?.captureScrollAnchor?.() : null);
  window.AlbumHavenDevicePreferences?.write('mobileGridColumns', columns);
  syncMobileGalleryControls();
  if (typeof virtualGrid !== 'undefined' && virtualGrid) virtualGrid.lastKey = '';
  renderArtistGroups({ preserveScroll: true, semanticScrollAnchor: anchor });
  if (anchor) virtualGrid.restoreScrollAnchor(anchor);
  return true;
}
let mobileGalleryPinchCancel = null;
function cancelMobileGalleryPinch() { mobileGalleryPinchCancel?.(); }
function initMobileGalleryPinch() {
  const gallery = document.getElementById('albums-scroll');
  if (!gallery || gallery.dataset.pinchBound === 'true') return;
  gallery.dataset.pinchBound = 'true';
  let gesture = null, suppressClickUntil = 0;
  const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  const eligible = () => usesMobilePageLayout() && !mobilePageState.pages.length
    && ['cards', 'covers'].includes(ensureGalleryMainState().view);
  const finish = (cancelled = false) => {
    const completed = gesture;
    if (!completed) return;
    gesture = null;
    suppressClickUntil = Date.now() + 450;
    const columns = cancelled ? completed.columns : completed.targetColumns;
    const anchor = virtualGrid.finishPinchPreview(columns, { cancelled });
    if (!cancelled && columns !== completed.columns) setMobileGalleryColumns(columns, { anchor });
  };
  mobileGalleryPinchCancel = () => finish(true);
  gallery.addEventListener('touchstart', event => {
    if (!eligible() || event.touches.length > 2) { finish(true); return; }
    if (gesture) {
      if (gesture.partiallyReleased || event.touches.length !== 2
        || Array.from(event.touches).some(touch => !gesture.identifiers.includes(touch.identifier))) finish(true);
      return;
    }
    if (event.touches.length !== 2) return;
    const span = distance(event.touches);
    if (span < 24) return;
    const saved = window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 3);
    const columns = [1, 2, 3].includes(saved) ? saved : 3;
    if (typeof virtualGrid === 'undefined' || !virtualGrid.beginPinchPreview({
      clientX: (event.touches[0].clientX + event.touches[1].clientX) / 2,
      clientY: (event.touches[0].clientY + event.touches[1].clientY) / 2,
      columns,
    })) return;
    gesture = { targetColumns: columns, distance: span, columns,
      identifiers: Array.from(event.touches, touch => touch.identifier), partiallyReleased: false,
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true };
    if (event.cancelable) event.preventDefault();
    closeGalleryMainSurface(false);
  }, { passive: false });
  gallery.addEventListener('touchmove', event => {
    if (!eligible() || event.touches.length > 2) { finish(true); return; }
    if (!gesture || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    suppressClickUntil = Date.now() + 450;
    const scale = distance(event.touches) / gesture.distance;
    gesture.targetColumns = resolvePinchColumns(gesture.columns, scale);
    if (!gesture.reducedMotion) virtualGrid.updatePinchPreview(resolvePinchDensity(gesture.columns, scale));
  }, { passive: false });
  // Keep the touched DOM mounted until both fingers lift. Replacing it mid-gesture
  // cancels native touch delivery and can strand the gallery at an intermediate scale.
  gallery.addEventListener('touchend', event => {
    if (!event.touches.length) finish(!eligible());
    else if (gesture) gesture.partiallyReleased = true;
  }, { passive: true });
  gallery.addEventListener('touchcancel', () => finish(true), { passive: true });
  window.addEventListener('resize', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  window.addEventListener('pagehide', () => finish(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(true); });
  gallery.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}

let mobileGalleryHintShown = false;
function showMobileGalleryPinchHint() {
  if (mobileGalleryHintShown || !usesMobilePageLayout() || mobilePageState.pages.length
    || state.ui?.pendingViewTransition || shouldShowMobileHome() || ensureGalleryMainState().view === 'list') return;
  const gallery = document.getElementById('albums-scroll');
  if (!gallery || !gallery.querySelector('.album-card')) return;
  mobileGalleryHintShown = true;
  const hint = document.createElement('div');
  hint.className = 'mobile-pinch-hint';
  hint.setAttribute('role', 'status');
  hint.innerHTML = '<span aria-hidden="true"><i></i><i></i></span>Pinch with two fingers to resize covers';
  document.getElementById('shell-main-surface').appendChild(hint);
  scheduleBrowserTimeout(() => hint.remove(), 4000);
}

// Mobile index/detail composition retains the same utility data and action owners.
function openMobileUtilityDetail(key) {
  const page = mobilePageState.pages.at(-1);
  if (!usesMobilePageLayout() || page?.kind !== 'utilities' || !['log-history', 'problematic-files'].includes(page.tab)) return;
  if (!page.utilityDetail) {
    page.utilityListPosition = window.history.state?.albumHavenNavigationPosition ?? null;
    writeMobilePageHistory('replace');
    page.utilityDetail = key;
    writeMobilePageHistory();
  } else page.utilityDetail = key;
  syncMobileUtilityDetail();
  document.getElementById('mobile-page-outlet').scrollTop = 0;
}
function syncMobileUtilityDetail() {
  const page = mobilePageState.pages.at(-1);
  const modal = document.getElementById('utility-modal');
  if (!modal) return;
  modal.dataset.mobileUtilityView = page?.utilityDetail ? 'detail' : 'list';
}
