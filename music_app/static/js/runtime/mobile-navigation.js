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
    document.getElementById('mobile-page-summary').textContent = active.subtitle;
    document.title = `${active.title} — Album Haven`;
  }
  document.getElementById('mobile-settings-actions').hidden = active?.kind !== 'utilities';
  scheduleMobileAlbumThumbnail();
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
    setUtilityActiveTab(mobileUtilityTabAllowed(descriptor.tab) ? descriptor.tab : 'appearance');
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
  descriptor.title = MOBILE_UTILITY_SECTIONS[state.utility.activeTab]?.label || 'Settings';
  descriptor.subtitle = '';
  descriptor.tab = state.utility.activeTab;
  syncMobilePageShell();
  syncMobileUtilityNavigation();
  if (!mobilePageState.restoring) writeMobilePageHistory('replace');
}
function syncMobileGalleryControls() {
  const savedColumns = window.AlbumHavenDevicePreferences?.read('mobileGridColumns', 2);
  const columns = [1, 2, 3].includes(savedColumns) ? savedColumns : 2;
  document.documentElement.style.setProperty('--mobile-gallery-columns', String(columns));
  document.querySelectorAll('[data-mobile-grid-density]').forEach(button => {
    button.hidden = !usesMobilePageLayout() || ensureGalleryMainState().view === 'list';
    button.title = `Gallery zoom: ${columns} ${columns === 1 ? 'column' : 'columns'}`;
  });
  document.querySelectorAll('[data-mobile-grid-columns]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.mobileGridColumns) === columns));
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
      if (mobile) document.getElementById('mobile-search-dock')?.appendChild(form);
      else {
        placeholder.after(form);
        const input = document.getElementById('search-input');
        if (input) { input.inert = false; input.removeAttribute('aria-hidden'); }
        submit?.removeAttribute('aria-expanded');
      }
      if (mobile) setMobileSearchOpen(mobilePageState.searchOpen);
    }
    syncMobileGalleryControls();
    syncMobilePageShell();
  };
  document.getElementById('mobile-page-outlet')?.addEventListener('scroll', scheduleMobileAlbumThumbnail, { passive: true });
  window.addEventListener('resize', scheduleMobileAlbumThumbnail, { passive: true });
  syncLayout();
  window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
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
    updatePlayerUi();
    if (typeof renderMobileHome === 'function') renderMobileHome();
  });
  document.addEventListener('click', (event) => {
    if (handleMobileSettingsClick(event)) return;
    if (event.target.closest?.('[data-mobile-back]')) navigateMobileBack();
    const density = event.target.closest?.('[data-mobile-grid-density]');
    if (density) {
      openGalleryMainSurface('gallery-density', density, document.getElementById('mobile-gallery-density-menu'));
      return;
    }
    const choice = event.target.closest?.('[data-mobile-grid-columns]');
    if (choice) {
      const columns = Number(choice.dataset.mobileGridColumns);
      if (![1, 2, 3].includes(columns)) return;
      window.AlbumHavenDevicePreferences?.write('mobileGridColumns', columns);
      closeGalleryMainSurface(true);
      syncMobileGalleryControls();
      if (virtualGrid) { virtualGrid.lastKey = ''; virtualGrid.recalculate(); }
      renderArtistGroups({ preserveScroll: true });
      renderMobileHome();
    }
  });
  // Enforce presentation restrictions at all delegated mobile action entry points.
  document.addEventListener('click', (event) => {
    if (!isMobileClient()) return;
    if (event.target.closest?.('[data-open-non-album-tag-editor], [data-open-tag-editor], [data-edit-tags], [data-edit-album-tags], [data-edit-track-tags], [data-utility-tab="problematic-files"], [data-revert-version-exception], [data-revert-problem-ignore], [data-delete-saved-loop]')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobilePageState.searchOpen && form?.contains(event.target)) {
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
    try { restoreMobilePage({ kind: url.searchParams.get('mobile_page'), albumKey: url.searchParams.get('mobile_album') || '', title: 'Album', tab: url.searchParams.get('utility_tab') }); }
    finally { mobilePageState.restoring = false; }
    // A directly loaded page has no guaranteed in-app previous entry.
    window.history.replaceState({ ...(window.history.state || {}), mobilePages: [] }, '', window.location.href);
  }
}


const MOBILE_UTILITY_SECTIONS = Object.freeze({
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
function mobileUtilitySubsections() {
  const list = getUtilityModalElements().list;
  const appearance = state.utility.activeTab === 'appearance';
  if (!appearance && state.utility.activeTab !== 'integrations') return [];
  const attribute = appearance ? 'data-utility-appearance-key' : 'data-utility-integration-key';
  const selected = appearance ? state.utility.appearanceKey : state.utility.selectedIntegrationKey;
  return [...(list?.querySelectorAll(`[${attribute}]`) || [])].map(node => ({
    key: node.getAttribute(attribute), label: node.getAttribute(attribute) === 'lastfm' ? 'Scrobbling' : node.textContent.trim(), selected: node.getAttribute(attribute) === selected,
  })).filter(item => appearance || item.key !== 'library' || window.__ALBUM_HAVEN_UTILITY_ALLOWED_ACTIONS__?.['library.settings.read'] === true);
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
  trigger.hidden = !choices.length;
  trigger.querySelector('[data-mobile-subsection-label]').textContent = choices.find(item => item.selected)?.label || 'Sections';
  const menuSignature = JSON.stringify(choices);
  if (menu.dataset.renderKey !== menuSignature) {
    menu.innerHTML = choices.map(item => `<button class="gallery-menu-action" type="button" data-mobile-subsection="${escapeHtml(item.key)}" aria-pressed="${item.selected}">${escapeHtml(item.label)}</button>`).join('');
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
      const attribute = state.utility.activeTab === 'appearance' ? 'data-utility-appearance-key' : 'data-utility-integration-key';
      [...getUtilityModalElements().list.querySelectorAll(`[${attribute}]`)].find(node => node.getAttribute(attribute) === choice.dataset.mobileSubsection)?.click();
    }
    return true;
  }
  return false;
}
let mobileAlbumThumbnailFrame = 0;
function scheduleMobileAlbumThumbnail() {
  if (mobileAlbumThumbnailFrame) return;
  mobileAlbumThumbnailFrame = requestAnimationFrame(() => {
    mobileAlbumThumbnailFrame = 0;
    const active = mobilePageState.pages.at(-1);
    const thumbnail = document.getElementById('mobile-page-cover');
    if (!thumbnail) return;
    const outlet = document.getElementById('mobile-page-outlet');
    const cover = document.getElementById('track-modal-cover');
    const show = active?.kind === 'album' && Boolean(active.coverSrc) && cover && outlet
      && cover.getBoundingClientRect().bottom <= outlet.getBoundingClientRect().top + 1;
    thumbnail.hidden = !show;
    if (show && thumbnail.getAttribute('src') !== active.coverSrc) thumbnail.src = active.coverSrc;
    if (!show && active?.kind !== 'album') thumbnail.removeAttribute('src');
  });
}
