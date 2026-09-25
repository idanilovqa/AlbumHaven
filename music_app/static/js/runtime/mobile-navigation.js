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
  const subtitle = album ? [album.album_artist || album.artist, album.year, album.total_duration_display].filter(Boolean).join(' · ') : '';
  return { kind, albumKey, title: kind === 'utilities' ? 'Settings' : kind === 'cover-lookup' ? 'Cover lookup' : kind === 'non-album' ? 'Non-album tracks' : String(album?.name || 'Album'),
    subtitle, tab: kind === 'utilities' ? state.utility.activeTab : '' };
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
  for (const descriptor of mobilePageState.pages) {
    const element = document.getElementById(MOBILE_PAGE_KINDS[descriptor.kind]);
    if (element) { element.hidden = descriptor !== active; element.inert = descriptor !== active; }
  }
  if (active) {
    document.getElementById('mobile-page-title').textContent = active.title;
    document.getElementById('mobile-page-summary').textContent = active.subtitle;
    document.title = `${active.title} — Album Haven`;
  }
  // A page is not a modal and must never trap focus away from the persistent player.
  if (!document.querySelector('[aria-modal="true"]:not([hidden])')?.getClientRects().length) document.body.classList.remove('modal-open');
}
function writeMobilePageHistory(mode = 'push') {
  const url = new URL(window.location.href);
  const active = mobilePageState.pages.at(-1);
  ['mobile_page', 'mobile_album', 'utility_tab'].forEach(key => url.searchParams.delete(key));
  if (active) {
    url.searchParams.set('mobile_page', active.kind);
    if (active.albumKey) url.searchParams.set('mobile_album', active.albumKey);
    if (active.kind === 'utilities') url.searchParams.set('utility_tab', active.tab || 'appearance');
  }
  const snapshot = { ...(window.history.state || {}), mobilePages: mobilePageState.pages.map(page => ({ ...page })) };
  if (mode === 'replace') window.history.replaceState(snapshot, '', url);
  else if (window.AlbumHavenSettingsNavigation?.instance?.pushLibraryHistory) window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory(url.href, snapshot);
  else window.history.pushState(snapshot, '', url);
}
function presentMobilePage(descriptor) {
  if (!usesMobilePageLayout() && !mobilePageState.pages.length) return false;
  const outlet = document.getElementById('mobile-page-outlet');
  const element = document.getElementById(MOBILE_PAGE_KINDS[descriptor.kind]);
  if (!outlet || !element) return false;
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
  if (previousIndex >= 0) mobilePageState.pages.splice(previousIndex);
  mobilePageState.pages.push(descriptor);
  closeArtistsDrawer({ restoreFocus: false });
  closeGalleryMainSurface?.(false);
  syncMobilePageShell();
  if (!mobilePageState.restoring) writeMobilePageHistory();
  requestAnimationFrame(() => document.getElementById('mobile-page-header')?.focus({ preventScroll: true }));
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
  if (window.history.state?.mobilePages?.length) window.history.back();
  else {
    const descriptor = mobilePageState.pages.pop();
    const focus = cleanupMobilePage(descriptor);
    writeMobilePageHistory('replace');
    syncMobilePageShell();
    if (focus?.isConnected) focus.focus({ preventScroll: true });
  }
  return true;
}
function navigateMobileBack() {
  const active = mobilePageState.pages.at(-1);
  if (!active) return;
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
    setUtilityActiveTab(['appearance', 'integrations'].includes(descriptor.tab) ? descriptor.tab : 'appearance');
    openUtilityModal();
  } else if (descriptor.kind === 'cover-lookup' && album) void openCoverLookupModal(album);
}
function handleMobilePagePopState() {
  const requested = Array.isArray(window.history.state?.mobilePages) ? window.history.state.mobilePages : [];
  const hadPage = mobilePageState.pages.length > 0;
  if (!hadPage && !requested.length) return false;
  let common = 0;
  while (common < requested.length && common < mobilePageState.pages.length
    && requested[common].kind === mobilePageState.pages[common].kind
    && requested[common].albumKey === mobilePageState.pages[common].albumKey) common += 1;
  let focus;
  while (mobilePageState.pages.length > common) focus = cleanupMobilePage(mobilePageState.pages.pop());
  mobilePageState.restoring = true;
  try { requested.slice(common).forEach(restoreMobilePage); }
  finally { mobilePageState.restoring = false; }
  syncMobilePageShell();
  if (!requested.length && focus?.isConnected) requestAnimationFrame(() => focus.focus({ preventScroll: true }));
  return true;
}
function syncMobileUtilityContext() {
  const descriptor = mobilePageState.pages.find(page => page.kind === 'utilities');
  if (!descriptor) return;
  descriptor.title = state.utility.activeTab === 'integrations' ? 'Integrations' : 'Appearance';
  descriptor.subtitle = 'Settings · Saved to your account';
  descriptor.tab = state.utility.activeTab;
  syncMobilePageShell();
  if (!mobilePageState.restoring) writeMobilePageHistory('replace');
}
function syncMobileGalleryControls() {
  const columns = window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 2) === 3 ? 3 : 2;
  document.documentElement.style.setProperty('--mobile-gallery-columns', String(columns));
  document.querySelectorAll('[data-mobile-grid-density]').forEach(button => {
    button.hidden = !usesMobilePageLayout() || ensureGalleryMainState().view === 'list';
    button.setAttribute('aria-label', columns === 2 ? 'Use three columns' : 'Use two columns');
    button.title = button.getAttribute('aria-label');
    button.querySelector('[data-mobile-grid-density-label]').textContent = `${columns} columns`;
  });
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
  mobilePageState.searchOpen = Boolean(open);
  const nav = document.getElementById('mobile-navigation');
  nav?.classList.toggle('is-search-open', Boolean(open));
  document.getElementById('mobile-search-button')?.setAttribute('aria-expanded', String(Boolean(open)));
  const form = document.getElementById('search-form');
  if (usesMobilePageLayout() && form) { form.inert = !open; form.setAttribute('aria-hidden', String(!open)); }
  if (open) document.getElementById('search-input')?.focus();
}
function initMobileNavigation() {
  if (mobilePageState.initialized || !document.getElementById('mobile-navigation')) return;
  mobilePageState.initialized = true;
  const form = document.getElementById('search-form');
  const placeholder = document.createComment('Desktop search position');
  form?.before(placeholder);
  const syncLayout = () => {
    const mobile = usesMobilePageLayout();
    document.documentElement.dataset.clientProfile = window.AlbumHavenDevicePreferences?.profile() || (isMobileClient() ? 'mobile' : 'web_desktop');
    if (form) {
      if (mobile) document.getElementById('mobile-search-dock')?.appendChild(form);
      else { placeholder.after(form); form.inert = false; form.removeAttribute('aria-hidden'); }
      if (mobile) setMobileSearchOpen(mobilePageState.searchOpen);
    }
    syncMobileGalleryControls();
    syncMobilePageShell();
  };
  syncLayout();
  window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
    const saved = window.AlbumHavenDevicePreferences?.read('galleryDisplayPreferences', null);
    if (saved && !new URL(window.location.href).searchParams.has('gallery_display')) {
      state.gallery.displayPreferences = saved;
      state.gallery.mainState.view = saved.defaultGalleryDisplayMode;
      state.view.gallery_display_mode = saved.defaultGalleryDisplayMode;
    }
    syncLayout();
    if (virtualGrid) { virtualGrid.lastKey = ''; virtualGrid.recalculate(); }
    renderArtistGroups({ preserveScroll: true });
    if (typeof renderMobileHome === 'function') renderMobileHome();
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-mobile-search]')) setMobileSearchOpen(!mobilePageState.searchOpen);
    if (event.target.closest?.('[data-mobile-back]')) navigateMobileBack();
    const density = event.target.closest?.('[data-mobile-grid-density]');
    if (density) {
      const columns = window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 2) === 3 ? 2 : 3;
      window.AlbumHavenDevicePreferences?.write('mobileGridColumns', columns);
      syncMobileGalleryControls();
      if (virtualGrid) { virtualGrid.lastKey = ''; virtualGrid.recalculate(); }
      renderArtistGroups({ preserveScroll: true });
      renderMobileHome();
    }
    const libraryMode = event.target.closest?.('[data-mobile-library-mode]');
    if (libraryMode) {
      const mode = libraryMode.dataset.mobileLibraryMode;
      document.querySelectorAll('[data-mobile-library-mode]').forEach(button => button.setAttribute('aria-pressed', String(button === libraryMode)));
      document.getElementById('artist-tree-expanded').hidden = mode !== 'artists';
      const empty = document.getElementById('mobile-library-placeholder');
      empty.hidden = mode === 'artists';
      empty.textContent = mode === 'playlists' ? 'Playlists will appear here when playlist support is available.' : 'Album tops will appear here when album rankings are available.';
    }
  });
  // Enforce presentation restrictions at all delegated mobile action entry points.
  document.addEventListener('click', (event) => {
    if (!isMobileClient()) return;
    if (event.target.closest?.('[data-open-non-album-tag-editor], [data-open-tag-editor], [data-edit-tags], [data-edit-album-tags], [data-edit-track-tags], [data-account-menu-admin], [data-utility-tab="problematic-files"], [data-utility-tab="rules"], [data-utility-tab="loops"], [data-utility-tab="log-history"]')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobilePageState.searchOpen && form?.contains(event.target)) {
      event.preventDefault(); setMobileSearchOpen(false); document.getElementById('mobile-search-button')?.focus(); return;
    }
    const rail = document.getElementById('shell-navigation-rail');
    if (event.key === 'Tab' && state.ui.artistsDrawerOpen && usesMobilePageLayout()) {
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
    try { restoreMobilePage({ kind: url.searchParams.get('mobile_page'), albumKey: url.searchParams.get('mobile_album') || '', title: 'Album', tab: url.searchParams.get('utility_tab') }); }
    finally { mobilePageState.restoring = false; }
    // A directly loaded page has no guaranteed in-app previous entry.
    window.history.replaceState({ ...(window.history.state || {}), mobilePages: [] }, '', window.location.href);
  }
}
