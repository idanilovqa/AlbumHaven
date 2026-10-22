/* Responsive shell navigation. Existing components retain their data and event owners. */
const mobilePageState = { pages: [], originals: new Map(), restoring: false, cleaning: false, initialized: false, searchOpen: false };
const MOBILE_PAGE_KINDS = Object.freeze({ album: 'track-modal', utilities: 'utility-modal', 'cover-lookup': 'cover-lookup-modal', 'non-album': 'non-album-modal', form: 'app-form-modal' });

function currentMobileFormOwner() {
  return typeof getActiveAppFormPage === 'function' ? getActiveAppFormPage() : null;
}
// Live-only destinations and return receipts are never serialized into history.
const advancedFormDestinations = new WeakMap();
let advancedFormReturnReceipt = null;
function advancedParentPages(snapshot) {
  const pages = window.AlbumHavenSettingsNavigation?.sanitizeHistorySnapshot?.(snapshot || {})?.mobilePages;
  return JSON.stringify(Array.isArray(pages) ? pages : []);
}
function currentAdvancedReplacement(context) {
  const operation = context?.operation;
  return Boolean(operation && context.nonce === operation.nonce && context.scope === operation.scope
    && context.intentRevision === operation.intentRevision
    && canRetainMobileFormParent(context.isCurrent) && canRetainMobileFormParent(() => operation.isCurrent()));
}
function canDismissAdvancedMobileForm(token, context) {
  if (!currentAdvancedReplacement(context)) return false;
  const descriptor = mobilePageState.pages.find(page => page.kind === 'form' && page.formToken === token);
  if (!descriptor) return true;
  const delta = mobileParentHistoryDelta(descriptor.parentPosition, window.history.state?.albumHavenNavigationPosition);
  return delta === null || Boolean(advancedFormDestinations.get(descriptor));
}
function ownsAdvancedFormReturn(receipt) {
  return Boolean(receipt && advancedFormReturnReceipt === receipt
    && mobilePageState.formReturn === receipt.returnOwner
    && receipt.returnOwner.parent === receipt.formDescriptor
    && receipt.formDescriptor.formToken === receipt.formToken
    && receipt.operation === receipt.context.operation && receipt.sessionId === receipt.operation.sessionId
    && receipt.nonce === receipt.operation.nonce
    && receipt.scope === receipt.operation.scope && currentAdvancedReplacement(receipt.context));
}
function detachAdvancedFormReturn(receipt) {
  if (advancedFormReturnReceipt === receipt) advancedFormReturnReceipt = null;
  if (receipt) receipt.phase = 'retired';
}
function cancelAdvancedFormReturn(receipt) {
  if (!receipt) return;
  const returning = receipt.returnOwner;
  if (mobilePageState.formReturn === returning) mobilePageState.formReturn = null;
  detachAdvancedFormReturn(receipt);
  returning.resolve(false);
}
function classifyAdvancedFormReturn(event) {
  const receipt = advancedFormReturnReceipt;
  if (!receipt || receipt.phase !== 'armed' || !ownsAdvancedFormReturn(receipt)) return null;
  const matches = snapshot => snapshot?.albumHavenNavigationPosition === receipt.expectedPosition
    && advancedParentPages(snapshot) === receipt.expectedParentPages;
  if (!matches(event.state) || !matches(window.history.state) || window.location.href !== receipt.expectedHref) return null;
  receipt.phase = 'consuming'; receipt.consumedEvent = event;
  return receipt;
}
function isMobileFormReturning() { return Boolean(mobilePageState.formReturn); }
function cancelSupersededMobileFormReturn() {
  const pending = mobilePageState.formReturn;
  if (!pending || (window.history.state?.albumHavenNavigationPosition === pending.position
    && (!pending.searchReceipt || ownsAdvancedFormReturn(pending.searchReceipt)))) return;
  detachAdvancedFormReturn(pending.searchReceipt);
  // A newer browser traversal owns this destination. Settling the old close
  // as successful would replay its opener or restore focus over that choice.
  mobilePageState.formReturn = null;
  mobilePageState.formReplacement = null;
  window.AlbumHavenArtistPageRuntime?.syncPresentation();
  pending.resolve(false);
}
function deferAppFormPageReplacement(onConfirmed, leaveContext = null) {
  const operation = leaveContext?.operation;
  const current = () => !leaveContext || canRetainMobileFormParent(leaveContext.isCurrent);
  let terminal = false;
  const outcome = (status, reason) => {
    if (!leaveContext || terminal) return;
    terminal = true; leaveContext.onOutcome?.({status, reason, operation});
  };
  if (!current()) {outcome('superseded', 'stale-intent'); return Promise.resolve(false);}
  if (isMobileFormReturning()) {outcome('cancelled', 'busy'); return Promise.resolve(false);}
  const form = currentMobileFormOwner();
  if (!form) {
    mobilePageState.formReplacement = null;
    const navigation = window.AlbumHavenSettingsNavigation?.instance;
    return !mobilePageState.restoring && ((navigation?.deferCollectionDraftNavigation || navigation?.deferPlaylistDraftNavigation)?.(onConfirmed, leaveContext) || false);
  }
  if (mobilePageState.formReplacement) {outcome('cancelled', 'busy'); return Promise.resolve(false);}
  const pending = {form, operation}; mobilePageState.formReplacement = pending;
  let nativeOutcome = null;
  const closeOptions = {restoreFocus: false};
  if (leaveContext) Object.assign(closeOptions, {
    dismissalOperation: {identity: operation, nonce: operation.nonce, sessionId: operation.sessionId},
    isCurrent: current,
    onDismissOutcome: result => {nativeOutcome = result;},
    searchReplacement: {operation, nonce: operation.nonce, scope: operation.scope,
      intentRevision: operation.intentRevision, isCurrent: current},
  });
  return Promise.resolve(form.dismiss('replace', closeOptions)).then(accepted => {
    if (mobilePageState.formReplacement !== pending) {outcome('superseded', 'replacement-owner'); return false;}
    mobilePageState.formReplacement = null;
    if (leaveContext) {
      if (!nativeOutcome || nativeOutcome.operation !== operation || nativeOutcome.nonce !== operation.nonce
        || nativeOutcome.formToken !== form.token) {outcome('failed', 'missing-dismissal-outcome'); return false;}
      if (nativeOutcome.status !== 'accepted') {outcome(nativeOutcome.status, nativeOutcome.reason); return false;}
    }
    if (!current() || !form.isCurrentContext() || currentMobileFormOwner()) {outcome('superseded', 'form-owner'); return false;}
    if (!accepted) {outcome('failed', 'missing-dismissal-outcome'); return false;}
    try {return onConfirmed?.();}
    catch (error) {
      if (!leaveContext) throw error;
      outcome(current() ? 'failed' : 'superseded', 'continuation-error'); return false;
    }
  }, () => {
    if (mobilePageState.formReplacement === pending) mobilePageState.formReplacement = null;
    outcome(current() ? 'failed' : 'superseded', 'dismiss-error'); return false;
  });
}
function presentMobileAppFormPage(owner) {
  if (currentMobileFormOwner() !== owner) return false;
  return presentMobilePage({kind: 'form', formToken: owner.token, albumKey: '', title: owner.title, subtitle: ''});
}
function updateMobileAppFormPresentation(owner) {
  if (currentMobileFormOwner() !== owner) return false;
  const page = mobilePageState.pages.find(value => value.kind === 'form' && value.formToken === owner.token);
  if (!page) return false;
  page.title = owner.title;
  syncMobilePageShell(); writeMobilePageHistory('replace');
  return true;
}
function canRetainMobileFormParent(check) {
  try {return typeof check === 'function' && check() === true;} catch {return false;}
}
// A form is a live session, never a restorable data snapshot. Only the native
// owner can retire it; history keeps an opaque identity, with no draft content.
function retireMobileAppFormPage(token, {restoreFocus = true, updateHistory = true, returnToParent = true, isCurrent = () => true, retainParentView, searchReplacement = null} = {}) {
  if (mobilePageState.cleaning) return;
  const index = mobilePageState.pages.findIndex(page => page.kind === 'form' && page.formToken === token);
  if (index < 0) return;
  const descriptor = mobilePageState.pages[index];
  if (searchReplacement && !canDismissAdvancedMobileForm(token, searchReplacement)) return false;
  const snapshot = window.history.state?.mobilePages;
  const ownsEntry = Array.isArray(snapshot) && snapshot.some(page => page.kind === 'form' && page.formToken === token);
  const delta = updateHistory && returnToParent && ownsEntry
    ? mobileParentHistoryDelta(descriptor.parentPosition, window.history.state?.albumHavenNavigationPosition) : null;
  // Publish return ownership before cleanup/shell callbacks can observe the
  // descriptor-removal midpoint. This lease is live only, never serialized.
  let resolveReturn;
  const returned = delta !== null ? new Promise(resolve => {resolveReturn = resolve;}) : null;
  const returning = updateHistory ? {resolve: resolveReturn || (() => {}), isCurrent, retainParentView,
    position: descriptor.parentPosition, parent: descriptor, artistParent: null} : null;
  let receipt = null;
  if (returning && searchReplacement) {
    const destination = advancedFormDestinations.get(descriptor);
    receipt = {identity: {}, operation: searchReplacement.operation, context: searchReplacement,
      nonce: searchReplacement.nonce, sessionId: searchReplacement.operation.sessionId, scope: searchReplacement.scope, intentRevision: searchReplacement.intentRevision,
      formToken: token, formDescriptor: descriptor, returnOwner: returning,
      originPosition: window.history.state?.albumHavenNavigationPosition,
      expectedPosition: descriptor.parentPosition, expectedHref: destination?.parentHref,
      expectedParentPages: destination?.parentPages, phase: delta === null ? 'local' : 'armed', consumedEvent: null};
    returning.searchReceipt = receipt;
    mobilePageState.formReturn = returning; advancedFormReturnReceipt = receipt;
  }
  if (returning) {
    if (!receipt) mobilePageState.formReturn = returning;
    returning.artistParent = window.AlbumHavenArtistPageRuntime?.captureFormReturn(
      () => mobilePageState.formReturn === returning && isCurrent(),
    ) || null;
  }
  if (receipt && !ownsAdvancedFormReturn(receipt)) {
    if (mobilePageState.formReturn === returning) mobilePageState.formReturn = null;
    detachAdvancedFormReturn(receipt); returning.resolve(false); return returned || false;
  }
  const retired = mobilePageState.pages.splice(index).reverse();
  for (const page of retired) {
    if (receipt && !ownsAdvancedFormReturn(receipt)) break;
    cleanupMobilePage(page);
  }
  if (!receipt || ownsAdvancedFormReturn(receipt)) syncMobilePageShell();
  if (delta !== null) {
    if (mobilePageState.formReturn !== returning || !isCurrent()
      || (receipt && (!ownsAdvancedFormReturn(receipt) || window.history.state?.albumHavenNavigationPosition !== receipt.originPosition))) {
      if (mobilePageState.formReturn === returning) mobilePageState.formReturn = null;
      detachAdvancedFormReturn(receipt); returning.resolve(false); window.AlbumHavenArtistPageRuntime?.syncPresentation();
      return returned;
    }
    window.history.go(delta);
    return returned;
  }
  const ownsReturn = () => returning && mobilePageState.formReturn === returning
    && canRetainMobileFormParent(isCurrent) && (!receipt || ownsAdvancedFormReturn(receipt)) && mobilePageState.formReturn === returning;
  if (updateHistory && ownsReturn()) writeMobilePageHistory('replace');
  const accepted = ownsReturn() && (!returning.artistParent || returning.artistParent.settle()) && ownsReturn();
  if (mobilePageState.formReturn === returning) mobilePageState.formReturn = null;
  detachAdvancedFormReturn(receipt);
  window.AlbumHavenArtistPageRuntime?.syncPresentation();
  const artistStillCurrent = !returning?.artistParent || window.AlbumHavenArtistPageRuntime?.snapshot().sessionId === returning.artistParent.sessionId;
  if (accepted && artistStillCurrent && !mobilePageState.formReturn && canRetainMobileFormParent(isCurrent)
    && restoreFocus && !receipt && !mobilePageState.pages.length && !canRetainMobileFormParent(retainParentView)) restoreMobileGalleryParent(retired.at(-1));
  if (searchReplacement) return Boolean(accepted && artistStillCurrent && canRetainMobileFormParent(isCurrent) && currentAdvancedReplacement(searchReplacement));
}

function isMobileClient() {
  return window.AlbumHavenDevicePreferences?.profile?.() === 'mobile'
    || window.AlbumHavenClientLayout?.classifyProfile({ viewportWidth: window.innerWidth, userAgent: window.navigator?.userAgent,
      platform: window.navigator?.platform, maxTouchPoints: window.navigator?.maxTouchPoints }) === 'mobile';
}
function usesMobilePageLayout() { return Number(window.innerWidth) <= 900; }
const ARTIST_SHEET_PRESENTATION = 'artist-discography-sheet';
const mobileArtistSheetFocus = new Map();
const mobileArtistSheetReturnReceipts = new WeakMap();
function mobileArtistSheetFocusKey(descriptor) {
  return JSON.stringify([window.history.state?.albumHavenNavigationPosition, descriptor.artistRef, descriptor.albumKey,
    descriptor.parentPosition, descriptor.parentViewUrl]);
}
function rememberMobileArtistSheetFocus(descriptor) {
  if (!isMobileArtistSheet(descriptor)) return;
  const receipt = getTrackModalArtistSheetOrigin()?.captureReturn();
  if (!receipt) return;
  const key = mobileArtistSheetFocusKey(descriptor);
  mobileArtistSheetFocus.delete(key); mobileArtistSheetFocus.set(key, Object.freeze({receipt, runtime: window.AlbumHavenArtistPageRuntime,
    href: window.location.href, history: JSON.stringify(window.history.state?.mobilePages || [])}));
  mobileArtistSheetReturnReceipts.set(descriptor, receipt);
  while (mobileArtistSheetFocus.size > 20) mobileArtistSheetFocus.delete(mobileArtistSheetFocus.keys().next().value);
}
function currentMobileArtistSheetFocus() {
  const descriptor = normalizeArtistSheetDescriptor(window.history.state?.mobilePages?.[0]);
  if (!descriptor) return null;
  const saved = mobileArtistSheetFocus.get(mobileArtistSheetFocusKey(descriptor));
  return saved && saved.runtime === window.AlbumHavenArtistPageRuntime && saved.href === window.location.href
    && saved.history === JSON.stringify(window.history.state?.mobilePages || []) ? saved.receipt : null;
}
function retireMobileArtistSheetFocus(sessionId, runtime) {
  for (const [key, saved] of mobileArtistSheetFocus) {
    if (saved.receipt.sessionId === sessionId && saved.runtime === runtime) mobileArtistSheetFocus.delete(key);
  }
}
function normalizeArtistSheetDescriptor(value) {
  if (!value || value.kind !== 'album' || value.presentation !== ARTIST_SHEET_PRESENTATION
    || Object.prototype.hasOwnProperty.call(value, 'sourcePageToken')) return null;
  const bounded = (text, max) => typeof text === 'string' && text.trim() === text && text.length > 0
    && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text);
  if (!bounded(value.artistRef, 512) || !bounded(value.albumKey, 4096)) return null;
  let parent;
  try {
    parent = new URL(value.parentViewUrl, window.location.href);
    if (parent.origin !== window.location.origin || parent.hash
      || ['mobile_page', 'mobile_album'].some(key => parent.searchParams.has(key))) return null;
    parent.search = parent.searchParams.toString();
    if (parent.href !== value.parentViewUrl) return null;
  } catch {return null;}
  if (value.parentPosition !== null && (!Number.isSafeInteger(value.parentPosition) || value.parentPosition < 0)) return null;
  const scroll = value.parentScrollPosition;
  if (scroll !== null && (!scroll || !Number.isFinite(scroll.scrollTop) || scroll.scrollTop < 0
    || !Number.isFinite(scroll.scrollLeft) || scroll.scrollLeft < 0)) return null;
  const copy = (text, max) => typeof text === 'string' ? text.slice(0, max) : '';
  return {kind: 'album', albumKey: value.albumKey, title: copy(value.title, 1024), subtitle: copy(value.subtitle, 2048),
    coverSrc: copy(value.coverSrc, 8192), presentation: ARTIST_SHEET_PRESENTATION, artistRef: value.artistRef,
    parentViewUrl: parent.href, parentPosition: value.parentPosition,
    parentScrollPosition: scroll === null ? null : {scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft}};
}
function isMobileArtistSheet(descriptor) {
  return Boolean(normalizeArtistSheetDescriptor(descriptor)
    && typeof getTrackModalArtistSheetOrigin === 'function'
    && getTrackModalArtistSheetOrigin()?.isRetainedCurrent(descriptor));
}
function cancelMobileArtistSheetReturn() {mobilePageState.sheetReturn = null;}
// Keep only this accepted root return suspended while child cleanup can reenter.
// The existing Artist return receipt owns admission; this transaction owns order.
function beginMobileArtistSheetParentReturn(descriptor, {replace = false} = {}) {
  if (mobilePageState.presentationTransition || mobilePageState.pages[0] !== descriptor
    || !isMobileArtistSheet(descriptor)) return null;
  const runtime = window.AlbumHavenArtistPageRuntime, view = state.view;
  const requestId = state.ui?.activeViewRequestId;
  const captured = normalizeArtistSheetDescriptor(descriptor);
  if (!captured) return null;
  const descriptorSignature = JSON.stringify(captured);
  const descriptorCurrent = () => JSON.stringify(normalizeArtistSheetDescriptor(descriptor)) === descriptorSignature;
  const canonical = value => {try {const url = new URL(value, window.location.href); url.hash = '';
    url.search = url.searchParams.toString(); return url.href;} catch {return '';}};
  const history = () => ({href: window.location.href,
    position: Number.isSafeInteger(window.history.state?.albumHavenNavigationPosition)
      ? window.history.state.albumHavenNavigationPosition : null,
    pages: JSON.stringify(Array.isArray(window.history.state?.mobilePages) ? window.history.state.mobilePages : [])});
  const origin = history(), snapshot = runtime?.snapshot();
  if (!snapshot?.mounted || !snapshot.retained || !snapshot.entryUrl
    || window.AlbumHavenArtistPageRuntime !== runtime || state.view !== view
    || state.ui?.activeViewRequestId !== requestId || mobilePageState.pages[0] !== descriptor
    || mobilePageState.presentationTransition || !isMobileArtistSheet(descriptor) || !descriptorCurrent()) return null;
  const target = {href: origin.href, position: replace ? origin.position : snapshot.entryKey, pages: '[]'};
  const same = (left, right) => left.href === right.href && left.position === right.position && left.pages === right.pages;
  if (!replace && (canonical(origin.href) !== canonical(snapshot.entryUrl) || !same(history(), target))) return null;
  if (replace) {
    const destination = new URL(window.location.href);
    ['mobile_page', 'mobile_album', 'utility_tab', 'loop_song', 'loop_filter', 'utility_detail'].forEach(key => destination.searchParams.delete(key));
    if (canonical(destination.href) !== canonical(snapshot.entryUrl)) return null;
    target.href = destination.href;
  }
  const transition = {artistParent: null};
  let writing = false, finished = false;
  const owns = () => !finished && mobilePageState.presentationTransition === transition
    && window.AlbumHavenArtistPageRuntime === runtime && state.view === view
    && state.ui?.activeViewRequestId === requestId && descriptorCurrent()
    && (same(history(), origin) || writing && same(history(), target));
  mobilePageState.presentationTransition = transition;
  const afterRelease = () => window.AlbumHavenArtistPageRuntime === runtime && state.view === view
    && state.ui?.activeViewRequestId === requestId && !mobilePageState.presentationTransition
    && !mobilePageState.pages.length && same(history(), target) && descriptorCurrent()
    && runtime.snapshot().sessionId === snapshot.sessionId
    && window.AlbumHavenArtistPageRuntime === runtime && state.view === view
    && state.ui?.activeViewRequestId === requestId && !mobilePageState.presentationTransition
    && !mobilePageState.pages.length && same(history(), target) && descriptorCurrent();
  const finish = () => {
    if (finished) return false;
    finished = true;
    if (mobilePageState.presentationTransition !== transition) return false;
    mobilePageState.presentationTransition = null;
    if (window.AlbumHavenArtistPageRuntime === runtime) runtime.syncPresentation();
    return afterRelease();
  };
  try {
    transition.artistParent = runtime.captureFormReturn(owns);
    if (!transition.artistParent || transition.artistParent.sessionId !== snapshot.sessionId
      || !transition.artistParent.isCurrent()) {finish(); return null;}
  } catch (error) {finish(); throw error;}
  const current = () => owns() && transition.artistParent.isCurrent() && owns();
  return {current, finish, afterRelease,
    beforeReplace() {if (!replace || !current() || !same(history(), origin)) return false; writing = true; return true;},
    prepare() {
      if (!current() || mobilePageState.pages.length || !same(history(), target)) return false;
      if (!transition.artistParent.settle() || !current()) return false;
      const position = captured.parentScrollPosition;
      if (position
        && (captured.parentPosition === target.position || !Number.isSafeInteger(captured.parentPosition)
          || !Number.isSafeInteger(target.position))) {
        if (typeof virtualGrid === 'undefined' || !virtualGrid?.restoreOwnedAbsoluteScrollPosition(position)) return false;
      }
      return current() && !mobilePageState.pages.length && same(history(), target);
    }};
}
function retainMobileArtistSheetReturn(descriptor) {
  const receipt = typeof getTrackModalArtistSheetOrigin === 'function'
    ? getTrackModalArtistSheetOrigin()?.captureReturn() || mobileArtistSheetReturnReceipts.get(descriptor) : null;
  if (!receipt || descriptor?.presentation !== ARTIST_SHEET_PRESENTATION) return;
  mobilePageState.sheetReturn = {receipt, descriptor, href: window.location.href,
    position: window.history.state?.albumHavenNavigationPosition, runtime: window.AlbumHavenArtistPageRuntime};
}
function mobilePageDescriptor(kind, album = null) {
  const albumKey = album ? String(getAlbumRequestKey(album) || '') : '';
  const sourcePageToken = kind === 'album' && typeof getTrackModalSourcePageToken === 'function' ? getTrackModalSourcePageToken() : null;
  const subtitle = album ? [kind === 'cover-lookup' ? album.name : '', album.album_artist || album.artist, album.year, album.total_duration_display].filter(Boolean).join(' · ') : '';
  const sheet = kind === 'album' && !sourcePageToken && typeof getTrackModalArtistSheetMarker === 'function'
    ? getTrackModalArtistSheetMarker(album) : null;
  return { kind, albumKey, ...(sourcePageToken ? {sourcePageToken} : {}), ...(sheet || {}), title: kind === 'utilities' ? 'Settings' : kind === 'cover-lookup' ? 'Cover Art Look Up' : kind === 'non-album' ? 'Non-album tracks' : String(album?.name || 'Album'),
    subtitle, coverSrc: album && typeof albumHasDisplayCover === 'function' && albumHasDisplayCover(album) ? buildAlbumDisplayCoverUrl(album) : '', tab: kind === 'utilities' ? state.utility.activeTab : '' };
}
function nativeAlbumPagePresentationAllowed() {
  return typeof getTrackModalPresentationRestrictions !== 'function'
    || getTrackModalPresentationRestrictions()?.can_open_album_page !== false;
}
function syncMobilePageShell() {
  const mobile = usesMobilePageLayout();
  const requested = mobilePageState.pages.at(-1);
  const active = mobile && !(requested?.kind === 'album' && !nativeAlbumPagePresentationAllowed()) ? requested : null;
  const sheet = active && isMobileArtistSheet(active);
  const page = sheet ? null : active;
  const main = document.getElementById('shell-main-surface');
  const header = document.getElementById('mobile-page-header');
  const outlet = document.getElementById('mobile-page-outlet');
  if (!main || !header || !outlet) return;
  main.classList.toggle('has-mobile-page', Boolean(page));
  header.hidden = !page;
  outlet.hidden = !page;
  outlet.dataset.mobilePageKind = page?.kind || '';
  document.getElementById('mobile-back-button').hidden = !page;
  document.getElementById('mobile-library-button').hidden = Boolean(page);
  for (const kind of mobilePageState.originals.keys()) {
    const element = document.getElementById(MOBILE_PAGE_KINDS[kind]);
    const modalAlbum = kind === 'album' && !nativeAlbumPagePresentationAllowed();
    const retainedSheet = kind === 'album' && isMobileArtistSheet(mobilePageState.pages.find(item => item.kind === 'album'));
    setMobilePagePresentation(kind, mobile && !modalAlbum && !retainedSheet);
    if (element) { element.hidden = !modalAlbum && mobile && kind !== active?.kind; element.inert = !modalAlbum && mobile && kind !== active?.kind; }
  }
  if (page) {
    document.getElementById('mobile-page-title').textContent = active.title;
    const summary = document.getElementById('mobile-page-summary');
    summary.textContent = active.subtitle;
    if (active.loopCount) { const count = document.createElement('span'); count.className = 'mobile-loop-count'; count.textContent = active.loopCount; summary.appendChild(count); }
    document.title = `${active.title} — Album Haven`;
  }
  document.getElementById('mobile-settings-actions').hidden = active?.kind !== 'utilities';
  document.getElementById('mobile-settings-button').hidden = active?.kind !== 'utilities';
  if (typeof syncTrackModalArtistSheet === 'function') syncTrackModalArtistSheet(
    mobilePageState.pages.find(item => item.kind === 'album'), {mobile, foreground: Boolean(sheet)});
  syncMobileAlbumHeader();
  syncMobileLoopHeader();
  // A page is not a modal and must never trap focus away from the persistent player.
  const hasModal = [...document.querySelectorAll('[aria-modal="true"]:not([hidden])')]
    .some(dialog => dialog.getClientRects().length > 0);
  if (!hasModal) document.body.classList.remove('modal-open');
  else if (!mobile) document.body.classList.add('modal-open');
  window.AlbumHavenArtistPageRuntime?.syncPresentation();
  window.dispatchEvent(new Event('albumhaven:search-match-layout'));
}

// Transfer the existing surface only; descriptors and history continue to own
// its parent stack across breakpoint changes, and closing remains owner-driven.
function setMobilePagePresentation(kind, mobile) {
  if (kind === 'album' && !nativeAlbumPagePresentationAllowed()) mobile = false;
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
  const snapshot = { ...(window.history.state || {}), mobilePages: mobilePageState.pages.map(page => page.kind === 'form'
    ? {kind: 'form', formToken: page.formToken}
    : page.presentation === ARTIST_SHEET_PRESENTATION ? normalizeArtistSheetDescriptor(page) : {...page}).filter(Boolean) };
  if (mode === 'replace') return window.history.replaceState(window.AlbumHavenSettingsNavigation.sanitizeHistorySnapshot(snapshot), '', url);
  if (window.AlbumHavenSettingsNavigation?.instance?.pushLibraryHistory) return window.AlbumHavenSettingsNavigation.instance.pushLibraryHistory(url.href, snapshot);
  return window.history.pushState(window.AlbumHavenSettingsNavigation.sanitizeHistorySnapshot(snapshot), '', url);
}
// Header Back follows the retained parent, while browser Forward keeps the child.
function resolveMobileParentPosition(descriptor, previous, snapshot = {}) {
  const restored = Array.isArray(snapshot.mobilePages)
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey
      && page.presentation === descriptor.presentation && page.artistRef === descriptor.artistRef) : null;
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
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey
      && page.presentation === descriptor.presentation && page.artistRef === descriptor.artistRef) : null;
  const position = previous?.parentScrollPosition ?? restored?.parentScrollPosition ?? scroll;
  if (!position || !Number.isFinite(position.scrollTop) || !Number.isFinite(position.scrollLeft)) return null;
  return { scrollTop: Math.max(0, position.scrollTop), scrollLeft: Math.max(0, position.scrollLeft) };
}
function resolveMobileParentViewUrl(descriptor, previous, snapshot = {}, viewUrl = '') {
  const restored = Array.isArray(snapshot.mobilePages)
    ? snapshot.mobilePages.find(page => page.kind === descriptor.kind && page.albumKey === descriptor.albumKey
      && page.presentation === descriptor.presentation && page.artistRef === descriptor.artistRef) : null;
  return previous?.parentViewUrl ?? restored?.parentViewUrl ?? viewUrl;
}
function restoreMobileGalleryParent(descriptor) {
  const parentPosition = descriptor?.parentPosition;
  const destinationPosition = window.history?.state?.albumHavenNavigationPosition;
  const atParent = !Number.isSafeInteger(parentPosition) || !Number.isSafeInteger(destinationPosition)
    || parentPosition === destinationPosition;
  const position = atParent ? descriptor?.parentScrollPosition : null;
  const options = { preserveScroll: true };
  // Root '/' can display the canonical album gallery as well as Home. Retain
  // the owning view route, not its data, through this page's history entry.
  if (atParent && descriptor?.parentViewUrl) options.parentViewUrl = descriptor.parentViewUrl;
  if (position) {
    options.preserveAbsoluteScroll = true;
    options.absoluteScrollPosition = position;
    // Restore before the request too: equivalent responses may retain the mounted
    // gallery. The virtual grid already owns stabilization and row materialization.
    if (typeof virtualGrid !== 'undefined' && virtualGrid?.restoreOwnedAbsoluteScrollPosition(position)) {
      virtualGrid.render(true);
    }
  }
  const pending = mobilePageState.sheetReturn;
  if (pending?.descriptor === descriptor) options.restartIfSameUrl = true;
  const read = handleGalleryBootstrapPopState(options);
  if (!pending || pending.descriptor !== descriptor) return read;
  const current = () => mobilePageState.sheetReturn === pending && mobilePageState.pages.length === 0
    && window.location.href === pending.href && window.history.state?.albumHavenNavigationPosition === pending.position
    && window.AlbumHavenArtistPageRuntime === pending.runtime
    && !getTopmostOpenModal() && !state.busy && !state.ui?.pendingViewTransition;
  // The real Gallery request owns admission and its grid owns the stabilization
  // RAF. Focus runs after that RAF, never on merely-requested parent data.
  Promise.resolve(read).then(() => {
    if (!current()) {if (mobilePageState.sheetReturn === pending) mobilePageState.sheetReturn = null; return;}
    requestAnimationFrame(() => {
      if (!current()) return;
      requestAnimationFrame(() => {
        if (!current()) return;
        pending.runtime.restoreAlbumSheetFocus(pending.receipt, current);
        if (mobilePageState.sheetReturn === pending) mobilePageState.sheetReturn = null;
      });
    });
  }, () => {if (mobilePageState.sheetReturn === pending) mobilePageState.sheetReturn = null;});
  return read;
}
function presentMobilePage(descriptor) {
  if (!mobilePageState.restoring && typeof invalidateAdvancedSearchIntent === 'function') invalidateAdvancedSearchIntent('mobile-navigation');
  cancelMobileArtistSheetReturn();
  if (!mobilePageState.restoring) cancelArtistSheetRestore();
  if (descriptor.kind === 'album' && !nativeAlbumPagePresentationAllowed()) return false;
  if (!usesMobilePageLayout() && !mobilePageState.pages.length && descriptor.kind !== 'form') return false;
  const outlet = document.getElementById('mobile-page-outlet');
  const element = document.getElementById(MOBILE_PAGE_KINDS[descriptor.kind]);
  if (!outlet || !element) return false;
  const artistRuntime = window.AlbumHavenArtistPageRuntime;
  const transition = {artistParent: null}, previousTransition = mobilePageState.presentationTransition;
  const rootOpening = !mobilePageState.restoring && !mobilePageState.pages.length
    && descriptor.presentation === ARTIST_SHEET_PRESENTATION;
  const openingOrigin = rootOpening && typeof getTrackModalArtistSheetOrigin === 'function'
    ? getTrackModalArtistSheetOrigin() : null;
  const openingHref = window.location.href, openingPosition = window.history.state?.albumHavenNavigationPosition;
  const openingHistory = JSON.stringify(window.history.state?.mobilePages || []);
  let published = false;
  mobilePageState.presentationTransition = transition;
  const presentingView = state.view, presentingRequestId = state.ui?.activeViewRequestId;
  const ownsTransition = () => mobilePageState.presentationTransition === transition
    && state.view === presentingView && state.ui?.activeViewRequestId === presentingRequestId
    && (!transition.artistParent || transition.artistParent.isOwnerCurrent())
    && mobilePageState.presentationTransition === transition;
  const ownsBeforeCommit = () => ownsTransition() && (!transition.artistParent || transition.artistParent.isCurrent());
  try {
    // Parent-return receipts are invalidated by their exact transition guard;
    // child-presentation receipts additionally expose an explicit release.
    previousTransition?.artistParent?.release?.();
    // Capture the already-owned parent before changing the live descriptor
    // chain. A second child temporarily precedes its own browser-history push.
    transition.artistParent = artistRuntime?.captureChildPresentation(
      () => mobilePageState.presentationTransition === transition,
    ) || null;
    if (!ownsBeforeCommit()) return false;
    const previous = mobilePageState.pages.find(page => page.kind === descriptor.kind);
    descriptor.parentPosition = resolveMobileParentPosition(descriptor, previous, window.history.state || {});
    if (descriptor.kind === 'form' && !mobilePageState.restoring) {
      const inherited = previous && advancedFormDestinations.get(previous);
      if (inherited?.parentPosition === descriptor.parentPosition) advancedFormDestinations.set(descriptor, inherited);
      else if (!previous && descriptor.parentPosition === window.history.state?.albumHavenNavigationPosition) {
        advancedFormDestinations.set(descriptor, {parentPosition: descriptor.parentPosition,
          parentHref: window.location.href, parentPages: advancedParentPages(window.history.state)});
      }
    }
    descriptor.parentScrollPosition = resolveMobileParentScrollPosition(descriptor, previous, window.history.state || {},
      mobilePageState.pages.length ? null : document.getElementById('albums-scroll'));
    const draftParent = window.AlbumHavenSettingsNavigation?.instance?.isPlaylistDraftCurrent?.(window.history.state?.playlistDraft);
    if (!ownsBeforeCommit()) return false;
    descriptor.parentViewUrl = resolveMobileParentViewUrl(descriptor, previous, window.history.state || {},
      mobilePageState.pages[0]?.parentViewUrl || (draftParent ? window.location.href : buildUrl(state.view)));
    if (descriptor.presentation === ARTIST_SHEET_PRESENTATION) {
      const parent = new URL(descriptor.parentViewUrl, window.location.href);
      parent.search = parent.searchParams.toString(); descriptor.parentViewUrl = parent.href;
      if (!normalizeArtistSheetDescriptor(descriptor)) return false;
    }
    const active = mobilePageState.pages.at(-1);
    if (active?.kind === descriptor.kind && active.albumKey === descriptor.albumKey
      && active.sourcePageToken === descriptor.sourcePageToken
      && active.presentation === descriptor.presentation && active.artistRef === descriptor.artistRef
      && (descriptor.kind !== 'form' || active.formToken === descriptor.formToken)) {
      Object.assign(active, descriptor);
      syncMobilePageShell();
      return ownsBeforeCommit();
    }
    delete outlet.dataset.pageInteracted;
    if (!mobilePageState.originals.has(descriptor.kind)) {
      const placeholder = document.createComment(`Original ${descriptor.kind} surface`);
      element.before(placeholder);
      if (!ownsBeforeCommit()) {placeholder.remove(); return false;}
      const dialog = element.querySelector('[role="dialog"]') || element;
      mobilePageState.originals.set(descriptor.kind, { placeholder, dialog, role: dialog.getAttribute('role'),
        modal: dialog.getAttribute('aria-modal'), label: dialog.getAttribute('aria-label'), returnFocus: document.activeElement });
    }
    // A changed album reuses one component; older history entries retain its key for Back/Forward.
    const previousIndex = mobilePageState.pages.findIndex(page => page.kind === descriptor.kind);
    if (previousIndex >= 0) {
      // Returning to an existing page must retire intervening native owners.
      const retired = mobilePageState.pages.splice(previousIndex + 1);
      for (const page of retired.reverse()) {
        cleanupMobilePage(page);
        if (!ownsBeforeCommit()) return false;
      }
      mobilePageState.pages.splice(previousIndex, 1);
    }
    if (!ownsBeforeCommit()) return false;
    mobilePageState.pages.push(descriptor);
    closeArtistsDrawer({ restoreFocus: false });
    if (!ownsBeforeCommit()) return false;
    closeGalleryMainSurface?.(false);
    if (!ownsBeforeCommit()) return false;
    syncMobilePageShell();
    if (!ownsBeforeCommit()) return false;
    if (!mobilePageState.restoring && writeMobilePageHistory() === false) return false;
    if (!ownsTransition()) return false;
    published = true;
    rememberMobileArtistSheetFocus(descriptor);
    if (descriptor.kind === 'form') descriptor.historyPosition = window.history.state?.albumHavenNavigationPosition;
    const presentedView = state.view, presentedRequestId = state.ui?.activeViewRequestId;
    const presentedPosition = window.history.state?.albumHavenNavigationPosition, presentedUrl = window.location.href;
    const artistSessionId = transition.artistParent?.sessionId;
    const ownsFocus = () => state.view === presentedView && state.ui?.activeViewRequestId === presentedRequestId
      && window.history.state?.albumHavenNavigationPosition === presentedPosition && window.location.href === presentedUrl;
    requestAnimationFrame(() => {
      if (descriptor.kind === 'form' || mobilePageState.pages.at(-1) !== descriptor || !ownsFocus()) return;
      if (artistSessionId && (window.AlbumHavenArtistPageRuntime !== artistRuntime
        || artistRuntime.snapshot().sessionId !== artistSessionId || !ownsFocus())) return;
      if (isMobileArtistSheet(descriptor)) return;
      const inBody = document.getElementById('mobile-page-header')?.dataset.albumIdentityInBody === 'true';
      const title = document.getElementById(inBody ? 'mobile-album-identity-title' : 'mobile-page-title');
      if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
    });
    return true;
  } finally {
    try {
      // A rejected first root push has no committed child to return from.
      // Retire only its exact unpublished draft, without a history write or a
      // parent read. A replacement child or reentrant successor is not ours.
      if (!published && rootOpening && openingOrigin && getTrackModalArtistSheetOrigin() === openingOrigin
        && window.AlbumHavenArtistPageRuntime === artistRuntime && ownsBeforeCommit()
        && window.location.href === openingHref && window.history.state?.albumHavenNavigationPosition === openingPosition
        && JSON.stringify(window.history.state?.mobilePages || []) === openingHistory
        && mobilePageState.pages.length === 1 && mobilePageState.pages[0] === descriptor
        && getTrackModalArtistSheetOrigin() === openingOrigin) {
        openingOrigin.release();
        mobilePageState.pages.pop();
        cleanupMobilePage(descriptor);
        if (ownsTransition()) syncMobilePageShell();
      }
    } finally {
      transition.artistParent?.release();
      if (mobilePageState.presentationTransition === transition) {
        mobilePageState.presentationTransition = null;
        // Commit, rejection, throw and no-history exits all resume exact normal
        // lineage checks. An older finally never clears a reentrant successor.
        window.AlbumHavenArtistPageRuntime?.syncPresentation();
      }
    }
  }
}
function presentMobileAlbumPage(album) { return presentMobilePage(mobilePageDescriptor('album', album)); }
function presentMobileUtilityPage() { return presentMobilePage(mobilePageDescriptor('utilities')); }
function presentMobileCoverLookupPage(album) { return presentMobilePage(mobilePageDescriptor('cover-lookup', album)); }

function cleanupMobilePage(descriptor) {
  if (descriptor.kind === 'form') advancedFormDestinations.delete(descriptor);
  const element = document.getElementById(MOBILE_PAGE_KINDS[descriptor.kind]);
  const original = mobilePageState.originals.get(descriptor.kind);
  mobilePageState.cleaning = true;
  try {
    if (descriptor.kind === 'album') {
      settleMobileArtistSheetDismissal(descriptor, true);
      retainMobileArtistSheetReturn(descriptor); closeTrackModal();
    }
    else if (descriptor.kind === 'utilities') closeUtilityModal(true);
    else if (descriptor.kind === 'cover-lookup') closeCoverLookupModal();
    else if (descriptor.kind === 'non-album') closeNonAlbumModal();
    else if (descriptor.kind === 'form') {
      const owner = currentMobileFormOwner();
      if (owner?.token === descriptor.formToken) owner.close(null, {force: true, restoreFocus: false, updateHistory: false});
    }
  } finally { mobilePageState.cleaning = false; }
  if (element && original && !mobilePageState.pages.some(page => page.kind === descriptor.kind && page !== descriptor)) {
    setMobilePagePresentation(descriptor.kind, false);
    original.placeholder.replaceWith(element);
    mobilePageState.originals.delete(descriptor.kind);
  }
  return original?.returnFocus;
}
function settleMobileArtistSheetDismissal(descriptor, accepted) {
  const pending = mobilePageState.sheetDismissal;
  if (!pending || pending.descriptor !== descriptor) return;
  mobilePageState.sheetDismissal = null; pending.resolve(Boolean(accepted));
}
function requestMobileArtistSheetDismissal() {
  const descriptor = mobilePageState.pages.find(page => page.kind === 'album');
  if (!isMobileArtistSheet(descriptor)) return false;
  const previous = mobilePageState.sheetDismissal;
  if (previous?.descriptor === descriptor) return previous.promise;
  closeTrackModal();
  return mobilePageState.sheetDismissal?.descriptor === descriptor ? mobilePageState.sheetDismissal.promise : false;
}
function dismissMobilePage(kind) {
  if (mobilePageState.cleaning || !mobilePageState.pages.some(page => page.kind === kind)) return false;
  if (typeof invalidateAdvancedSearchIntent === 'function') invalidateAdvancedSearchIntent('mobile-navigation');
  if (kind === 'form') { void currentMobileFormOwner()?.dismiss('back'); return true; }
  const index = mobilePageState.pages.findIndex(page => page.kind === kind);
  const descriptor = mobilePageState.pages[index];
  if (kind === 'album' && isMobileArtistSheet(descriptor)) {
    if (mobilePageState.sheetDismissal?.descriptor === descriptor) return true;
    let resolve;
    const promise = new Promise(done => {resolve = done;});
    mobilePageState.sheetDismissal = {descriptor, promise, resolve};
  }
  const delta = mobileParentHistoryDelta(mobilePageState.pages[index].parentPosition,
    window.history.state?.albumHavenNavigationPosition);
  if (delta !== null) {
    // Popstate retires the surface only after the traversal commits. This also
    // keeps Forward usable, instead of overwriting the album's history entry.
    try {window.history.go(delta);} catch (error) {settleMobileArtistSheetDismissal(descriptor, false); throw error;}
    return true;
  }
  const returningSheet = index === 0 && isMobileArtistSheet(descriptor);
  const dismissal = returningSheet && mobilePageState.sheetDismissal?.descriptor === descriptor
    ? mobilePageState.sheetDismissal : null;
  const cancelDismissal = () => {if (!dismissal) return;
    if (mobilePageState.sheetDismissal === dismissal) settleMobileArtistSheetDismissal(descriptor, false);
    else dismissal.resolve(false);};
  let transaction = null;
  try {transaction = returningSheet ? beginMobileArtistSheetParentReturn(descriptor, {replace: true}) : null;}
  catch (error) {cancelDismissal(); throw error;}
  if (returningSheet && !transaction) {cancelDismissal(); return true;}
  try {
  const retired = mobilePageState.pages.splice(index).reverse();
  let focus;
  for (const descriptor of retired) {
    focus = cleanupMobilePage(descriptor);
    if (transaction && !transaction.current()) return true;
  }
  if (transaction && !transaction.beforeReplace()) return true;
  const written = writeMobilePageHistory('replace');
  if (transaction && (written === false || !transaction.prepare())) return true;
  if (mobilePageState.sheetReturn) {
    mobilePageState.sheetReturn.href = window.location.href;
    mobilePageState.sheetReturn.position = window.history.state?.albumHavenNavigationPosition;
  }
  if (transaction && !transaction.finish()) return true;
  syncMobilePageShell();
  if (transaction && !transaction.afterRelease()) return true;
  if (!mobilePageState.pages.length) restoreMobileGalleryParent(retired.at(-1));
  // Returning to the gallery should not leave the originating artbox visibly
  // selected after a pointer/back navigation.
  if (!mobilePageState.sheetReturn && focus?.isConnected) focus.blur();
  return true;
  } finally {try {transaction?.finish();} finally {cancelDismissal();}}
}
function navigateMobileBack() {
  if (typeof invalidateAdvancedSearchIntent === 'function') invalidateAdvancedSearchIntent('mobile-back');
  const active = mobilePageState.pages.at(-1);
  if (!active) return;
  if (active.kind === 'form') { void currentMobileFormOwner()?.dismiss('back'); return; }
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
function sourceMobileAlbumPageCurrent(descriptor) {
  return descriptor?.kind !== 'album' || !Object.prototype.hasOwnProperty.call(descriptor, 'sourcePageToken')
    || typeof isTrackModalSourcePageCurrent === 'function' && isTrackModalSourcePageCurrent(descriptor.sourcePageToken, descriptor.albumKey);
}
function currentSourceMobileRestore(pending = mobilePageState.sourceRestore) {
  if (!pending || pending.controller.signal.aborted) return false;
  const snapshot = window.history.state;
  return window.location.href === pending.href && snapshot?.albumHavenNavigationPosition === pending.position
    && Array.isArray(snapshot?.mobilePages) && snapshot.mobilePages.some(page => page.kind === 'album'
      && page.albumKey === pending.descriptor.albumKey && page.sourcePageToken === pending.descriptor.sourcePageToken);
}
function restoreSourceMobileAlbumPage(descriptor) {
  const previous = mobilePageState.sourceRestore;
  if (previous && currentSourceMobileRestore(previous)
    && previous.descriptor.sourcePageToken === descriptor.sourcePageToken && previous.descriptor.albumKey === descriptor.albumKey) return previous.promise;
  previous?.controller.abort();
  const pending = {descriptor, controller: new AbortController(), href: window.location.href, position: window.history.state?.albumHavenNavigationPosition};
  mobilePageState.sourceRestore = pending;
  const current = () => mobilePageState.sourceRestore === pending && currentSourceMobileRestore(pending);
  const unavailable = () => {
    if (!current()) return;
    mobilePageState.sourceRestore = null; pending.controller.abort();
    if (typeof showToast === 'function') showToast('This Album page is unavailable from its original source. Open it again from Recent or the original selection.', 'error', 4500);
    writeMobilePageHistory('replace'); syncMobilePageShell();
    if (!mobilePageState.pages.length) restoreMobileGalleryParent(descriptor);
  };
  const read = typeof restoreTrackModalSourcePage === 'function' ? restoreTrackModalSourcePage(descriptor, {
    signal: pending.controller.signal, isCurrent: current,
    present(open) {
      if (!current()) return false;
      const restoring = mobilePageState.restoring; mobilePageState.restoring = true;
      try {return open();} finally {mobilePageState.restoring = restoring;}
    },
  }) : Promise.resolve(false);
  pending.promise = Promise.resolve(read).then(restored => {
    if (!current()) return false;
    if (!restored) {unavailable(); return false;}
    mobilePageState.sourceRestore = null;
    // Keep the successful read signal alive: the current native source guard
    // uses it until a later read or native owner retires that authority.
    handleMobilePagePopState();
    return true;
  }, error => {
    if (error?.sourcePageSuperseded && current()) {
      mobilePageState.sourceRestore = null; pending.controller.abort();
    } else unavailable();
    return false;
  });
  return pending.promise;
}
function currentArtistSheetRestore(pending = mobilePageState.sheetRestore) {
  if (!pending || pending.controller.signal.aborted) return false;
  const snapshot = window.history.state;
  return mobilePageState.sheetRestore === pending && window.location.href === pending.href
    && snapshot?.albumHavenNavigationPosition === pending.position
    && JSON.stringify(snapshot.mobilePages || []) === pending.history;
}
function cancelArtistSheetRestore(pending = mobilePageState.sheetRestore) {
  if (!pending) return;
  pending.controller.abort(); pending.admission?.release();
  if (mobilePageState.sheetRestore === pending) mobilePageState.sheetRestore = null;
}
function prepareArtistSheetRestore(descriptor) {
  const previous = mobilePageState.sheetRestore;
  if (currentArtistSheetRestore(previous) && previous.descriptor.albumKey === descriptor.albumKey) return previous;
  cancelArtistSheetRestore(previous);
  const pending = {descriptor, controller: new AbortController(), href: window.location.href,
    position: window.history.state?.albumHavenNavigationPosition,
    history: JSON.stringify(window.history.state?.mobilePages || []), runtime: window.AlbumHavenArtistPageRuntime};
  mobilePageState.sheetRestore = pending;
  pending.admission = pending.runtime?.beginAlbumSheetReplay(descriptor, () => currentArtistSheetRestore(pending),
    currentMobileArtistSheetFocus());
  return pending;
}
function restoreArtistSheetPage(raw) {
  const descriptor = normalizeArtistSheetDescriptor(raw);
  if (!descriptor) return false;
  const pending = prepareArtistSheetRestore(descriptor);
  if (pending.promise) return pending.promise;
  const current = () => currentArtistSheetRestore(pending);
  const runtime = pending.runtime;
  const reject = () => {
    if (!current() || pending.admission?.isCurrent() !== true) {cancelArtistSheetRestore(pending); return false;}
    pending.admission?.release(); mobilePageState.sheetRestore = null; pending.controller.abort();
    // A history marker cannot grant ordinary Album access. Return through the
    // canonical parent instead of constructing the legacy preview-only Album.
    writeMobilePageHistory('replace'); syncMobilePageShell();
    if (!mobilePageState.pages.length) restoreMobileGalleryParent(descriptor);
    return false;
  };
  if (pending.admission?.isCurrent() !== true) {cancelArtistSheetRestore(pending); return Promise.resolve(false);}
  let load = Promise.resolve();
  if (!pending.admission?.hasParent()) {
    load = handleGalleryBootstrapPopState({parentViewUrl: descriptor.parentViewUrl, preserveScroll: true, restartIfSameUrl: true,
      preserveAbsoluteScroll: Boolean(descriptor.parentScrollPosition), absoluteScrollPosition: descriptor.parentScrollPosition,
      onStart({requestId}) {
        const controller = state.ui?.activeViewRequestController;
        if (!current() || !pending.admission?.bindRequest(requestId, controller)) return false;
        pending.controller.signal.addEventListener('abort', () => {
          if (state.ui?.activeViewRequestController === controller && state.ui?.activeViewRequestId === requestId) controller.abort();
        }, {once: true});
        return true;
      },
      shouldApplyResponse: () => current() && pending.admission?.isCurrent() === true,
      onSettled: result => pending.admission?.settleRequest(result)});
  }
  pending.promise = Promise.resolve(load).then(() => {
    if (!current() || runtime !== window.AlbumHavenArtistPageRuntime || pending.admission?.isCurrent() !== true) {
      cancelArtistSheetRestore(pending); return false;
    }
    const resolved = pending.admission?.resolve();
    if (!resolved || !current() || !nativeAlbumPagePresentationAllowed()) return reject();
    const restoring = mobilePageState.restoring; mobilePageState.restoring = true;
    try {
      const result = openTrackModal(resolved.album, {artistSheetOrigin: resolved.origin});
      if (result === false || !current()) {resolved.origin.release(); return reject();}
    } finally {mobilePageState.restoring = restoring;}
    // Retain the exact replay receipt while the remaining nested descriptors
    // reconcile; the live chain can temporarily precede the full saved chain.
    handleMobilePagePopState();
    if (!current()) {pending.admission.release(); return false;}
    pending.admission.release(); mobilePageState.sheetRestore = null;
    if (mobilePageState.pages.length < (window.history.state?.mobilePages || []).length) writeMobilePageHistory('replace');
    syncMobilePageShell();
    return true;
  }, reject);
  return pending.promise;
}
function restoreMobilePage(descriptor) {
  if (!descriptor || !Object.hasOwn(MOBILE_PAGE_KINDS, descriptor.kind)) return;
  if (descriptor.kind === 'form') {
    const owner = currentMobileFormOwner();
    if (owner?.token === descriptor.formToken) presentMobileAppFormPage(owner);
    return;
  }
  if (descriptor.presentation === ARTIST_SHEET_PRESENTATION) return restoreArtistSheetPage(descriptor);
  // A source-origin page can replay only through a fresh read of that source.
  if (descriptor.kind === 'album' && Object.prototype.hasOwnProperty.call(descriptor, 'sourcePageToken')
    && !sourceMobileAlbumPageCurrent(descriptor)) return restoreSourceMobileAlbumPage(descriptor);
  const album = descriptor.albumKey ? (getIndexedAlbum(descriptor.albumKey) || { key: descriptor.albumKey, name: descriptor.title || 'Album', preview_only: true }) : null;
  if (descriptor.kind === 'non-album') openNonAlbumModal();
  else if (descriptor.kind === 'album' && album) {
    const scoped = Object.prototype.hasOwnProperty.call(descriptor, 'sourcePageToken');
    openTrackModal(album, scoped ? {
      sourcePageOwner: getTrackModalSourcePageOwner(),
      presentationRestrictions: getTrackModalPresentationRestrictions(),
    } : {});
  }
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
function handleMobilePagePopState(onHistoryAccepted = null, searchReceipt = null) {
  if (searchReceipt) {
    if (searchReceipt.phase !== 'consuming' || !ownsAdvancedFormReturn(searchReceipt)) return false;
    const returning = searchReceipt.returnOwner;
    const current = () => ownsAdvancedFormReturn(searchReceipt);
    const accepted = current() && (!returning.artistParent || returning.artistParent.settle()) && current();
    if (!accepted) {
      if (mobilePageState.formReturn === returning) mobilePageState.formReturn = null;
      detachAdvancedFormReturn(searchReceipt); returning.resolve(false); return false;
    }
    // This exact pre-admission replacement owns no parent fetch or focus work.
    mobilePageState.formReturn = null; detachAdvancedFormReturn(searchReceipt);
    window.AlbumHavenArtistPageRuntime?.syncPresentation();
    const stillCurrent = canRetainMobileFormParent(returning.isCurrent)
      && currentAdvancedReplacement(searchReceipt.context);
    returning.resolve(stillCurrent);
    return stillCurrent;
  }
  // Settings may consume this traversal during capture, before the gallery's
  // bubble handler. Retire pending Search before even the desktop/no-page exit.
  if (typeof invalidateAdvancedSearchIntent === 'function') invalidateAdvancedSearchIntent('history');
  if (mobilePageState.sheetRestore && !currentArtistSheetRestore()) {
    cancelArtistSheetRestore();
  }
  if (mobilePageState.sheetReturn && (mobilePageState.sheetReturn.href !== window.location.href
    || mobilePageState.sheetReturn.position !== window.history.state?.albumHavenNavigationPosition)) cancelMobileArtistSheetReturn();
  if (mobilePageState.sourceRestore && !currentSourceMobileRestore()) {
    mobilePageState.sourceRestore.controller.abort(); mobilePageState.sourceRestore = null;
  }
  cancelSupersededMobileFormReturn();
  const requested = Array.isArray(window.history.state?.mobilePages) ? window.history.state.mobilePages : [];
  const hadPage = mobilePageState.pages.length > 0;
  const traversal = mobilePageState.formTraversal;
  if (traversal?.vetoed && currentMobileFormOwner() === traversal.form
    && requested.some(page => page.kind === 'form' && page.formToken === traversal.form.token)) mobilePageState.formTraversal = null;
  const returning = mobilePageState.formReturn;
  const ownsReturn = () => returning && mobilePageState.formReturn === returning
    && canRetainMobileFormParent(returning.isCurrent) && mobilePageState.formReturn === returning;
  const acceptedReturn = ownsReturn() && (!returning.artistParent || returning.artistParent.settle()) && ownsReturn();
  if (mobilePageState.formReturn === returning) mobilePageState.formReturn = null;
  else if (returning) {returning.resolve(false); return true;}
  if (!hadPage && !requested.length) {
    if (!returning) return false;
    window.AlbumHavenArtistPageRuntime?.syncPresentation();
    const artistStillCurrent = !returning.artistParent || window.AlbumHavenArtistPageRuntime?.snapshot().sessionId === returning.artistParent.sessionId;
    if (acceptedReturn && artistStillCurrent && !mobilePageState.formReturn && canRetainMobileFormParent(returning.isCurrent)
      && !canRetainMobileFormParent(returning.retainParentView)) restoreMobileGalleryParent(returning.parent);
    returning.resolve(Boolean(acceptedReturn));
    return true;
  }
  if (!returning) mobilePageState.formReplacement = null;
  const form = currentMobileFormOwner();
  if (form && mobilePageState.pages.some(page => page.kind === 'form' && page.formToken === form.token)
    && !requested.some(page => page.kind === 'form' && page.formToken === form.token)) {
    if (!mobilePageState.formTraversal) {
      const pending = {form, onHistoryAccepted, parent: mobilePageState.pages[0], position: mobilePageState.pages.find(page => page.kind === 'form')?.historyPosition};
      mobilePageState.formTraversal = pending;
      pending.artistParent = window.AlbumHavenArtistPageRuntime?.captureFormReturn(
        () => mobilePageState.formTraversal === pending && form.isCurrentContext(),
      ) || null;
      void form.dismiss('history', {restoreFocus: false, updateHistory: false}).then(accepted => {
        if (mobilePageState.formTraversal !== pending) return;
        if (currentMobileFormOwner() && currentMobileFormOwner() !== form) {mobilePageState.formTraversal = null; return;}
        if (!accepted) {
          const sheet = mobilePageState.pages.find(page => page.kind === 'album');
          settleMobileArtistSheetDismissal(sheet, false);
          if (currentMobileFormOwner() === form) {
            pending.vetoed = true;
            const position = window.history.state?.albumHavenNavigationPosition;
            const delta = Number.isSafeInteger(position) && Number.isSafeInteger(pending.position) ? pending.position - position : 0;
            if (delta) window.history.go(delta);
            else {writeMobilePageHistory('replace'); if (mobilePageState.formTraversal === pending) mobilePageState.formTraversal = null;}
          } else mobilePageState.formTraversal = null;
          window.AlbumHavenArtistPageRuntime?.syncPresentation();
          return;
        }
        if (mobilePageState.formTraversal === pending) mobilePageState.formTraversal = null;
        window.AlbumHavenArtistPageRuntime?.syncPresentation();
        if (!form.isCurrentContext()) return;
        if (pending.onHistoryAccepted) {pending.onHistoryAccepted(); return;}
        if (!handleMobilePagePopState()) restoreMobileGalleryParent(pending.parent);
      });
    }
    return true;
  }
  let common = 0;
  while (common < requested.length && common < mobilePageState.pages.length
    && requested[common].kind === mobilePageState.pages[common].kind
    && (requested[common].kind === 'form' ? requested[common].formToken === mobilePageState.pages[common].formToken
      : requested[common].albumKey === mobilePageState.pages[common].albumKey)
    && requested[common].presentation === mobilePageState.pages[common].presentation
    && requested[common].artistRef === mobilePageState.pages[common].artistRef
    && requested[common].sourcePageToken === mobilePageState.pages[common].sourcePageToken
    && sourceMobileAlbumPageCurrent(requested[common])
    && (requested[common].kind !== 'utilities'
      || (requested[common].tab === mobilePageState.pages[common].tab
        && String(requested[common].utilityDetail || '') === String(mobilePageState.pages[common].utilityDetail || '')
        && String(requested[common].loopSongId || '') === String(mobilePageState.pages[common].loopSongId || '')))) common += 1;
  const parent = mobilePageState.pages[0];
  const returningSheet = !requested.length && parent && isMobileArtistSheet(parent);
  const dismissal = returningSheet && mobilePageState.sheetDismissal?.descriptor === parent
    ? mobilePageState.sheetDismissal : null;
  const cancelDismissal = () => {if (!dismissal) return;
    if (mobilePageState.sheetDismissal === dismissal) settleMobileArtistSheetDismissal(parent, false);
    else dismissal.resolve(false);};
  let transaction = null;
  try {transaction = returningSheet ? beginMobileArtistSheetParentReturn(parent) : null;}
  catch (error) {cancelDismissal(); returning?.resolve(false); throw error;}
  if (returningSheet && !transaction) {cancelDismissal(); returning?.resolve(false); return true;}
  let returnResolved = false;
  try {
  const replay = requested.slice(common).find(page => page.presentation === ARTIST_SHEET_PRESENTATION);
  const normalizedReplay = replay && normalizeArtistSheetDescriptor(replay);
  // Capture a retained, actually admitted parent before committed cleanup
  // removes its old child chain. This receipt alone admits no response data.
  if (normalizedReplay) prepareArtistSheetRestore(normalizedReplay);
  let focus;
  while (mobilePageState.pages.length > common) {
    focus = cleanupMobilePage(mobilePageState.pages.pop());
    if (transaction && !transaction.current()) return true;
  }
  mobilePageState.restoring = true;
  try {
    for (const descriptor of requested.slice(common)) {
      const restored = restoreMobilePage(descriptor);
      if (restored && typeof restored.then === 'function') break;
    }
  }
  finally { mobilePageState.restoring = false; }
  if (mobilePageState.pages.length < requested.length && !currentSourceMobileRestore() && !currentArtistSheetRestore()) writeMobilePageHistory('replace');
  if (transaction && !transaction.prepare()) return true;
  if (transaction && !transaction.finish()) return true;
  syncMobilePageShell();
  if (transaction && !transaction.afterRelease()) return true;
  // A background refresh may have replaced the gallery while its child was open.
  // Restore the retained parent URL through the normal gallery request owner.
  if (!requested.length) restoreMobileGalleryParent(parent);
  else if (!currentSourceMobileRestore() && !mobilePageState.pages.length && requested.some(page => page.kind === 'album'
    && Object.prototype.hasOwnProperty.call(page, 'sourcePageToken'))) restoreMobileGalleryParent(requested[0]);
  else if (!mobilePageState.pages.length && requested.some(page => page.kind === 'form')) handleGalleryBootstrapPopState();
  if (!requested.length && !mobilePageState.sheetReturn && focus?.isConnected) requestAnimationFrame(() => focus.blur());
  returning?.resolve(Boolean(acceptedReturn));
  returnResolved = true;
  return true;
  } finally {try {transaction?.finish();} finally {cancelDismissal(); if (!returnResolved) returning?.resolve(false);}}
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
function prepareMobileGallerySearch(onConfirmed, skipAppearanceGuard = false, leaveContext = null) {
  const current = () => !leaveContext || canRetainMobileFormParent(leaveContext.isCurrent);
  const stale = () => {leaveContext?.onOutcome?.({status: 'superseded', reason: 'stale-intent', operation: leaveContext.operation}); return false;};
  if (!current()) return stale();
  if (deferAppFormPageReplacement(onConfirmed, leaveContext)) return false;
  if (!mobilePageState.pages.length) return true;
  if (!skipAppearanceGuard && mobilePageState.pages.some(page => page.kind === 'utilities')
    && typeof confirmBackgroundAppearanceLeave === 'function'
    && !confirmBackgroundAppearanceLeave(onConfirmed, leaveContext)) return false;
  if (!current()) return stale();
  if (typeof closeSearchAdvancedFilters === 'function') closeSearchAdvancedFilters({reason: 'mobile-teardown', searchOperation: leaveContext?.operation});
  while (mobilePageState.pages.length) {
    if (!current()) return stale();
    cleanupMobilePage(mobilePageState.pages.pop());
  }
  if (!current()) return stale();
  syncMobilePageShell();
  if (!current()) return stale();
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
  if (typeof admitsAdvancedEvent === 'function' && admitsAdvancedEvent(event)) return;
  if (!usesMobilePageLayout() || !mobilePageState.searchOpen) return;
  if (document.getElementById('search-form')?.contains(event.target)
    || document.getElementById('recent-search-popover')?.contains(event.target)
    || document.getElementById('search-advanced-panel')?.contains(event.target)) return;
  // Capture dismissal without cancelling the same tap's Settings/page action.
  setMobileSearchOpen(false);
}
function setMobileSearchOpen(open, searchOperation = null) {
  if (typeof invalidateAdvancedSearchIntent === 'function') invalidateAdvancedSearchIntent('mobile-teardown', {searchOperation});
  if (typeof closeSearchAdvancedFilters === 'function') closeSearchAdvancedFilters({reason: 'mobile-teardown', searchOperation});
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
function handleMobileSearchSubmit(searchOperation = null) {
  if (!usesMobilePageLayout()) return false;
  if (!mobilePageState.searchOpen) { setMobileSearchOpen(true, searchOperation); return true; }
  if (!String(document.getElementById('search-input')?.value || '').trim()) {
    setMobileSearchOpen(false, searchOperation);
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
    return element && !element.hidden && !mobilePageState.originals.has(kind);
  });
  for (const kind of visible) {
    if (kind === 'utilities' && !mobileUtilityTabAllowed(state.utility.activeTab)) {
      setUtilityActiveTab('appearance');
      void loadActiveUtilityTab();
    }
    const album = kind === 'album' ? getCurrentTrackModalAlbum()
      : kind === 'cover-lookup' ? state.coverLookup.modal.album : null;
    const descriptor = mobilePageDescriptor(kind, album);
    if (kind === 'album' && !sourceMobileAlbumPageCurrent(descriptor)) continue;
    presentMobilePage(descriptor);
    if (kind === 'utilities') renderUtilityModalContent();
  }
  const form = currentMobileFormOwner();
  if (form && !mobilePageState.originals.has('form')) presentMobileAppFormPage(form);
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
  pageOutlet?.addEventListener('scroll', () => {
    scheduleMobileAlbumThumbnail();
    window.dispatchEvent(new Event('albumhaven:search-match-layout'));
  }, { passive: true });
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
    if (typeof admitsAdvancedEvent === 'function' && admitsAdvancedEvent(event)) return;
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
    if (event.key === 'Escape' && !event.defaultPrevented && !event.repeat && !event.isComposing && event.keyCode !== 229
      && !(typeof admitsAdvancedEvent === 'function' && admitsAdvancedEvent(event))
      && !document.getElementById('search-advanced-panel')?.contains(event.target) && usesMobilePageLayout() && mobilePageState.searchOpen && form?.contains(event.target)) {
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
    const kind = url.searchParams.get('mobile_page'), albumKey = url.searchParams.get('mobile_album') || '';
    const savedPages = Array.isArray(window.history.state?.mobilePages) ? window.history.state.mobilePages : [];
    const saved = savedPages.find(page => page.kind === kind && page.albumKey === albumKey);
    try { restoreMobilePage({ ...(saved?.presentation === ARTIST_SHEET_PRESENTATION ? saved : {}), kind, albumKey, title: 'Album',
      ...(saved && Object.prototype.hasOwnProperty.call(saved, 'sourcePageToken') ? {sourcePageToken: saved.sourcePageToken} : {}),
      tab: url.searchParams.get('utility_tab'), utilityDetail: url.searchParams.get('utility_detail') || '', loopSongId: url.searchParams.get('loop_song') || '', loopFilter: url.searchParams.get('loop_filter') || '' }); }
    finally { mobilePageState.restoring = false; }
    // A directly loaded page has no guaranteed in-app previous entry.
    const loopPage = getMobileLoopPage();
    if (loopPage) {
      loopPage.parentPosition = null;
      loopPage.loopListPosition = null;
    }
    // Keep the restored page as a parent for any child opened after reload.
    if (!currentSourceMobileRestore() && !currentArtistSheetRestore()) writeMobilePageHistory('replace');
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
  const albumPage = active?.kind === 'album' && usesMobilePageLayout() && !isMobileArtistSheet(active);
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
