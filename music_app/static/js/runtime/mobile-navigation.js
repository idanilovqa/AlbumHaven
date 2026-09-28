/* Responsive shell navigation. Existing components retain their data and event owners. */
const mobilePageState = { pages: [], originals: new Map(), restoring: false, cleaning: false, initialized: false, searchOpen: false };
const MOBILE_PAGE_KINDS = Object.freeze({ album: 'track-modal', utilities: 'utility-modal', 'cover-lookup': 'cover-lookup-modal', 'non-album': 'non-album-modal' });

function isMobileClient() {
  return window.AlbumHavenDevicePreferences?.profile?.() === 'mobile'
    || window.AlbumHavenClientLayout?.classifyProfile({ viewportWidth: window.innerWidth, userAgent: window.navigator?.userAgent,
      platform: window.navigator?.platform, maxTouchPoints: window.navigator?.maxTouchPoints }) === 'mobile';
}
function usesMobilePageLayout() { return Number(window.innerWidth) <= 900; }
function mobilePageDescriptor(kind, album = null) {
  const albumKey = album ? String(getAlbumRequestKey(album) || '') : '';
  const subtitle = album ? [kind === 'cover-lookup' ? album.name : '', album.album_artist || album.artist, album.year, album.total_duration_display].filter(Boolean).join(' · ') : '';
  return { kind, albumKey, title: kind === 'utilities' ? 'Settings' : kind === 'cover-lookup' ? 'Cover Art Look Up' : kind === 'non-album' ? 'Non-album tracks' : String(album?.name || 'Album'),
    subtitle, coverSrc: album && typeof albumHasDisplayCover === 'function' && albumHasDisplayCover(album) ? buildAlbumDisplayCoverUrl(album) : '', tab: kind === 'utilities' ? state.utility.activeTab : '' };
}
function syncMobilePageShell() {
  const active = mobilePageState.pages.at(-1);
  const main = document.getElementById('shell-main-surface');
  const header = document.getElementById('mobile-page-header');
  const outlet = document.getElementById('mobile-page-outlet');
  if (!main || !header || !outlet) return;
  main.classList.toggle('has-mobile-page', Boolean(active));
  header.hidden = !active;
  outlet.hidden = !active;
  document.getElementById('mobile-back-button').hidden = !active;
  document.getElementById('mobile-library-button').hidden = Boolean(active);
  for (const kind of mobilePageState.originals.keys()) {
    const element = document.getElementById(MOBILE_PAGE_KINDS[kind]);
    if (element) { element.hidden = kind !== active?.kind; element.inert = kind !== active?.kind; }
  }
  if (active) {
    document.getElementById('mobile-page-title').textContent = active.title;
    const summary = document.getElementById('mobile-page-summary');
    summary.textContent = active.subtitle;
    if (active.loopCount) { const count = document.createElement('span'); count.className = 'mobile-loop-count'; count.textContent = active.loopCount; summary.appendChild(count); }
    document.title = `${active.title} — Album Haven`;
  }
  document.getElementById('mobile-settings-actions').hidden = active?.kind !== 'utilities';
  document.getElementById('mobile-settings-button').hidden = active?.kind !== 'utilities';
  syncMobileAlbumHeader();
  syncMobileLoopHeader();
  // A page is not a modal and must never trap focus away from the persistent player.
  if (!document.querySelector('[aria-modal="true"]:not([hidden])')?.getClientRects().length) document.body.classList.remove('modal-open');
}
function writeMobilePageHistory(mode = 'push') {
  const url = new URL(window.location.href);
  const active = mobilePageState.pages.at(-1);
  ['mobile_page', 'mobile_album', 'utility_tab', 'loop_song', 'loop_filter', 'utility_detail'].forEach(key => url.searchParams.delete(key));
  if (active) {
    url.searchParams.set('mobile_page', active.kind);
    if (active.albumKey) url.searchParams.set('mobile_album', active.albumKey);
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
function restoreMobileGalleryParent(descriptor) {
  const position = descriptor?.parentScrollPosition;
  const options = { preserveScroll: true };
  if (position) {
    options.preserveAbsoluteScroll = true;
    options.absoluteScrollPosition = position;
    // Restore before the request too: equivalent responses may retain the mounted
    // gallery. The virtual grid already owns stabilization and row materialization.
    if (typeof virtualGrid !== 'undefined' && virtualGrid?.restoreOwnedAbsoluteScrollPosition(position)) {
      virtualGrid.render(true);
    }
  }
  handleGalleryBootstrapPopState(options);
}
function presentMobilePage(descriptor) {
  if (!usesMobilePageLayout() && !mobilePageState.pages.length) return false;
  const outlet = document.getElementById('mobile-page-outlet');
  const element = document.getElementById(MOBILE_PAGE_KINDS[descriptor.kind]);
  if (!outlet || !element) return false;
  const previous = mobilePageState.pages.find(page => page.kind === descriptor.kind);
  descriptor.parentPosition = resolveMobileParentPosition(descriptor, previous, window.history.state || {});
  descriptor.parentScrollPosition = resolveMobileParentScrollPosition(descriptor, previous, window.history.state || {},
    mobilePageState.pages.length ? null : document.getElementById('albums-scroll'));
  const active = mobilePageState.pages.at(-1);
  if (active?.kind === descriptor.kind && active.albumKey === descriptor.albumKey) {
    Object.assign(active, descriptor);
    syncMobilePageShell();
    return true;
  }
  if (!mobilePageState.originals.has(descriptor.kind)) {
    const placeholder = document.createComment(`Original ${descriptor.kind} surface`);
    element.before(placeholder);
    const dialog = element.querySelector('[role="dialog"]') || element;
    mobilePageState.originals.set(descriptor.kind, { placeholder, dialog, role: dialog.getAttribute('role'),
      modal: dialog.getAttribute('aria-modal'), returnFocus: document.activeElement });
    dialog.setAttribute('role', 'region');
    dialog.removeAttribute('aria-modal');
    dialog.setAttribute('aria-label', descriptor.kind === 'album' ? 'Album details' : descriptor.title);
    element.classList.add('is-mobile-page');
    outlet.appendChild(element);
  }
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
  requestAnimationFrame(() => {
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
    element.inert = false;
    element.classList.remove('is-mobile-page');
    if (original.role === null) original.dialog.removeAttribute('role'); else original.dialog.setAttribute('role', original.role);
    if (original.modal === null) original.dialog.removeAttribute('aria-modal'); else original.dialog.setAttribute('aria-modal', original.modal);
    original.dialog.removeAttribute('aria-label');
    original.placeholder.replaceWith(element);
    mobilePageState.originals.delete(descriptor.kind);
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
  if (focus?.isConnected) focus.focus({ preventScroll: true });
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
  if (descriptor.kind === 'non-album') openNonAlbumModal();
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
function handleMobilePagePopState() {
  const requested = Array.isArray(window.history.state?.mobilePages) ? window.history.state.mobilePages : [];
  const hadPage = mobilePageState.pages.length > 0;
  if (!hadPage && !requested.length) return false;
  let common = 0;
  while (common < requested.length && common < mobilePageState.pages.length
    && requested[common].kind === mobilePageState.pages[common].kind
    && requested[common].albumKey === mobilePageState.pages[common].albumKey
    && (requested[common].kind !== 'utilities'
      || (requested[common].tab === mobilePageState.pages[common].tab
        && String(requested[common].utilityDetail || '') === String(mobilePageState.pages[common].utilityDetail || '')
        && String(requested[common].loopSongId || '') === String(mobilePageState.pages[common].loopSongId || '')))) common += 1;
  const parent = mobilePageState.pages[0];
  let focus;
  while (mobilePageState.pages.length > common) focus = cleanupMobilePage(mobilePageState.pages.pop());
  mobilePageState.restoring = true;
  try { requested.slice(common).forEach(restoreMobilePage); }
  finally { mobilePageState.restoring = false; }
  syncMobilePageShell();
  // A background refresh may have replaced the gallery while its child was open.
  // Restore the retained parent URL through the normal gallery request owner.
  if (!requested.length) restoreMobileGalleryParent(parent);
  if (!requested.length && focus?.isConnected) requestAnimationFrame(() => focus.focus({ preventScroll: true }));
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
function prepareMobileGallerySearch(onConfirmed, skipAppearanceGuard = false) {
  if (!mobilePageState.pages.length) return true;
  if (!skipAppearanceGuard && mobilePageState.pages.some(page => page.kind === 'utilities')
    && typeof confirmBackgroundAppearanceLeave === 'function'
    && !confirmBackgroundAppearanceLeave(onConfirmed)) return false;
  while (mobilePageState.pages.length) cleanupMobilePage(mobilePageState.pages.pop());
  syncMobilePageShell();
  // Keep the page behind the new search entry available through browser Back.
  writeMobilePageHistory();
  return true;
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
  if (input && usesMobilePageLayout()) { input.inert = !open; input.setAttribute('aria-hidden', String(!open)); }
  if (open) input?.focus();
}
function handleMobileSearchSubmit() {
  if (!usesMobilePageLayout()) return false;
  if (!mobilePageState.searchOpen) { setMobileSearchOpen(true); return true; }
  if (!String(document.getElementById('search-input')?.value || '').trim()) { setMobileSearchOpen(false); return true; }
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
    return element && !element.hidden && !mobilePageState.originals.has(kind);
  });
  for (const kind of visible) {
    if (kind === 'utilities' && !mobileUtilityTabAllowed(state.utility.activeTab)) {
      setUtilityActiveTab('appearance');
      void loadActiveUtilityTab();
    }
    const album = kind === 'album' ? getCurrentTrackModalAlbum()
      : kind === 'cover-lookup' ? state.coverLookup.modal.album : null;
    presentMobilePage(mobilePageDescriptor(kind, album));
    if (kind === 'utilities') renderUtilityModalContent();
  }
}

function initMobileNavigation() {
  if (mobilePageState.initialized || !document.getElementById('mobile-navigation')) return;
  mobilePageState.initialized = true;
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
      if (mobile) setMobileSearchOpen(mobilePageState.searchOpen || Boolean(document.getElementById('search-input')?.value?.trim()));
    }
    promoteVisibleMobileDialogs();
    syncMobileGalleryControls();
    syncMobilePageShell();
    if (['loops', 'integrations', 'log-history', 'problematic-files'].includes(state.utility.activeTab) && mobilePageState.pages.some(page => page.kind === 'utilities')) renderUtilityModalContent();
    if (typeof syncMobileAlbumComposition === 'function') syncMobileAlbumComposition(getCurrentTrackModalAlbum());
  };
  document.getElementById('mobile-page-outlet')?.addEventListener('scroll', scheduleMobileAlbumThumbnail, { passive: true });
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
  document.addEventListener('click', (event) => {
    if (usesMobilePageLayout() && mobilePageState.searchOpen && !form?.contains(event.target)
      && !String(document.getElementById('search-input')?.value || '').trim()) setMobileSearchOpen(false);
    if (handleMobileSettingsClick(event)) return;
    if (event.target.closest?.('[data-mobile-back]')) navigateMobileBack();

  });
  // Enforce presentation restrictions at all delegated mobile action entry points.
  document.addEventListener('click', (event) => {
    if (!isMobileClient()) return;
    if (event.target.closest?.('[data-open-problematic-album-folder], [data-open-non-album-tag-editor], [data-open-tag-editor], [data-edit-tags], [data-edit-album-tags], [data-edit-track-tags], [data-revert-version-exception], [data-revert-problem-ignore], [data-delete-saved-loop]')) {
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
    if (event.key === 'Escape' && mobilePageState.searchOpen && form?.contains(event.target)
      && !String(document.getElementById('search-input')?.value || '').trim()) {
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
  const url = new URL(window.location.href);
  if (usesMobilePageLayout() && url.searchParams.has('mobile_page')) {
    mobilePageState.restoring = true;
    try { restoreMobilePage({ kind: url.searchParams.get('mobile_page'), albumKey: url.searchParams.get('mobile_album') || '', title: 'Album', tab: url.searchParams.get('utility_tab'), utilityDetail: url.searchParams.get('utility_detail') || '', loopSongId: url.searchParams.get('loop_song') || '', loopFilter: url.searchParams.get('loop_filter') || '' }); }
    finally { mobilePageState.restoring = false; }
    // A directly loaded page has no guaranteed in-app previous entry.
    const loopPage = getMobileLoopPage();
    if (loopPage) {
      loopPage.parentPosition = null;
      loopPage.loopListPosition = null;
    }
    // Keep the restored page as a parent for any child opened after reload.
    writeMobilePageHistory('replace');
  }
}


const MOBILE_UTILITY_SECTIONS = Object.freeze({
  'problematic-files': { label: 'Problematic Files', action: 'library.problems.read' },
  rules: { label: 'Rules', action: 'library.rules.read' },
  loops: { label: 'Loops', action: 'library.loops.read' },
  'log-history': { label: 'Log History', action: 'library.logs.read' },
  integrations: { label: 'Integrations', action: 'integration.settings.read' },
  appearance: { label: 'Appearance', action: null },
});
function mobileUtilityTabAllowed(tab, actions = window.__ALBUM_HAVEN_UTILITY_ALLOWED_ACTIONS__ || {}) {
  const section = Object.hasOwn(MOBILE_UTILITY_SECTIONS, tab) ? MOBILE_UTILITY_SECTIONS[tab] : null;
  return Boolean(section && (!section.action || actions[section.action] === true));
}
function mobileUtilitySubsectionAttribute(tab = state.utility.activeTab) {
  return ({ appearance: 'data-utility-appearance-key', integrations: 'data-utility-integration-key', rules: 'data-utility-rule-key' })[tab] || '';
}
function mobileUtilitySubsections() {
  const list = getUtilityModalElements().list;
  const attribute = mobileUtilitySubsectionAttribute();
  if (!attribute) return [];
  const selected = state.utility.activeTab === 'appearance' ? state.utility.appearanceKey
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
  if (!header || !context || !thumbnail) return;
  const active = mobilePageState.pages.at(-1);
  const outlet = document.getElementById('mobile-page-outlet');
  const cover = document.getElementById('track-modal-cover');
  const identity = document.querySelector('#track-modal .mobile-album-identity');
  const albumPage = active?.kind === 'album' && usesMobilePageLayout();
  const hasInlineIdentity = albumPage && identity && !identity.hidden;
  const presentation = resolveMobileAlbumHeaderState({
    albumPage,
    hasInlineIdentity,
    hasCover: Boolean(active?.coverSrc),
    viewportTop: outlet?.getBoundingClientRect().top,
    coverBottom: albumPage ? cover?.getBoundingClientRect().bottom : undefined,
    identityBottom: hasInlineIdentity ? identity.getBoundingClientRect().bottom : undefined,
  });
  header.dataset.inlineAlbumLayout = String(Boolean(hasInlineIdentity));
  header.dataset.albumIdentityInBody = String(presentation.bodyOwnsIdentity);
  // One Back button: beside the cover initially, in the pinned bar after handoff.
  const back = document.getElementById('mobile-back-button');
  const overview = document.querySelector('#track-modal .mobile-album-overview');
  const backHost = presentation.bodyOwnsIdentity && overview ? overview : header;
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
  thumbnail.hidden = !presentation.showCover;
  if (presentation.showCover && thumbnail.getAttribute('src') !== active.coverSrc) thumbnail.src = active.coverSrc;
  if (active?.kind !== 'album') thumbnail.removeAttribute('src');
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
function setMobileGalleryColumns(columns) {
  if (![1, 2, 3].includes(columns) || !usesMobilePageLayout()) return false;
  if (window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 3) === columns) return false;
  const anchor = typeof virtualGrid !== 'undefined' ? virtualGrid?.captureScrollAnchor?.() : null;
  window.AlbumHavenDevicePreferences?.write('mobileGridColumns', columns);
  syncMobileGalleryControls();
  if (typeof virtualGrid !== 'undefined' && virtualGrid) virtualGrid.lastKey = '';
  renderArtistGroups({ preserveScroll: true });
  if (anchor) virtualGrid.restoreScrollAnchor(anchor);
  return true;
}
function initMobileGalleryPinch() {
  const gallery = document.getElementById('albums-scroll');
  if (!gallery || gallery.dataset.pinchBound === 'true') return;
  gallery.dataset.pinchBound = 'true';
  let gesture = null, suppressClickUntil = 0;
  const distance = touches => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  gallery.addEventListener('touchstart', event => {
    if (!usesMobilePageLayout() || ensureGalleryMainState().view === 'list') return;
    if (event.touches.length !== 2) { gesture = null; return; }
    const span = distance(event.touches);
    if (span < 24) return;
    gesture = { targetColumns: null, distance: span, columns: window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 3) || 3 };
    if (event.cancelable) event.preventDefault();
    closeGalleryMainSurface(false);
  }, { passive: false });
  gallery.addEventListener('touchmove', event => {
    if (!gesture || event.touches.length !== 2) return;
    if (event.cancelable) event.preventDefault();
    suppressClickUntil = Date.now() + 450;
    gesture.targetColumns = resolvePinchColumns(gesture.columns, distance(event.touches) / gesture.distance);
  }, { passive: false });
  // Keep the touched DOM mounted until both fingers lift. Replacing it mid-gesture
  // cancels native touch delivery and can strand the gallery at an intermediate scale.
  const finish = event => {
    const completed = gesture;
    if (completed) suppressClickUntil = Date.now() + 450;
    gesture = null;
    if (event.type === 'touchend' && completed?.targetColumns) setMobileGalleryColumns(completed.targetColumns);
  };
  gallery.addEventListener('touchend', finish, { passive: true });
  gallery.addEventListener('touchcancel', finish, { passive: true });
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
