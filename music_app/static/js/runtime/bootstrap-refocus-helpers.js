const VIEWPORT_REFOCUS_SUPPRESSION_GRACE_MS = 400;
const VIEWPORT_REFOCUS_HOVER_UNLOCK_COUNT = 2;
const VIEWPORT_REFOCUS_EXEMPT_SELECTOR = '.global-player, #track-modal, #utility-modal, #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #repair-confirm-modal, #repair-progress-overlay, #tag-editor-modal, #tag-edit-confirm-modal, #loop-delete-confirm-modal, #image-lightbox, #non-album-modal, #version-picker-modal, #cover-lookup-drawer, #gallery-options-menu, #album-card-context-menu, #status-context-menu, #track-modal-version-context-menu, #recent-search-popover';
const VIEWPORT_REFOCUS_INTENT_SELECTOR = '.album-card, [data-album-key], [data-track-path], [data-version-context-key], .artist-link, .album-title-button, .button, .icon-button, .play-track-button, .gallery-options-menu-item, .related-chip, a, button, input, select, textarea, label';
const COVER_LOOKUP_REFOCUS_GUARDED_SELECTOR = '[data-select-local-cover], [data-select-pasted-cover], [data-select-remote-cover]';

function getViewportRefocusEventTarget(event) {
  return event?.target instanceof Element ? event.target : null;
}

function isViewportRefocusExemptTarget(target) {
  const coverLookupSelection = target?.closest(COVER_LOOKUP_REFOCUS_GUARDED_SELECTOR);
  if (coverLookupSelection?.closest('#cover-lookup-modal')) return false;
  return Boolean(target?.closest(VIEWPORT_REFOCUS_EXEMPT_SELECTOR));
}

function resetViewportRefocusIntentTracking() {
  state.ui.refocusHoverIntentCount = 0;
  state.ui.refocusLastHoverIntentKey = '';
}

function clearViewportRefocusSuppression() {
  state.ui.suppressNextViewportClick = false;
  state.ui.suppressClickSequenceUntil = 0;
  resetViewportRefocusIntentTracking();
}

function armViewportRefocusSuppression() {
  state.ui.suppressNextViewportClick = true;
  state.ui.suppressClickSequenceUntil = 0;
  resetViewportRefocusIntentTracking();
}

function isViewportRefocusSuppressionActive(now = Date.now()) {
  return Boolean(
    state.ui.suppressNextViewportClick
    || now <= Number(state.ui.suppressClickSequenceUntil || 0)
  );
}

function resolveViewportRefocusIntentKey(target) {
  const candidate = target?.closest?.(VIEWPORT_REFOCUS_INTENT_SELECTOR);
  if (!(candidate instanceof Element)) return '';
  if (candidate.dataset.albumKey) return `album:${candidate.dataset.albumKey}`;
  if (candidate.dataset.trackPath) return `track:${candidate.dataset.trackPath}`;
  if (candidate.dataset.versionContextKey) return `version:${candidate.dataset.versionContextKey}`;
  if (candidate.id) return `id:${candidate.id}`;
  if (candidate.className) return `class:${candidate.className}`;
  return candidate.tagName ? `tag:${candidate.tagName.toLowerCase()}` : '';
}

function noteViewportRefocusHoverIntent(event) {
  if (!state.ui.suppressNextViewportClick) return false;
  const target = getViewportRefocusEventTarget(event);
  if (!target || isViewportRefocusExemptTarget(target)) return false;
  const intentKey = resolveViewportRefocusIntentKey(target);
  if (!intentKey || intentKey === state.ui.refocusLastHoverIntentKey) return false;
  state.ui.refocusLastHoverIntentKey = intentKey;
  state.ui.refocusHoverIntentCount = Number(state.ui.refocusHoverIntentCount || 0) + 1;
  if (state.ui.refocusHoverIntentCount < VIEWPORT_REFOCUS_HOVER_UNLOCK_COUNT) {
    return false;
  }
  clearViewportRefocusSuppression();
  return true;
}

function noteViewportRefocusWheelIntent(event) {
  if (!state.ui.suppressNextViewportClick) return false;
  const target = getViewportRefocusEventTarget(event);
  if (!target || isViewportRefocusExemptTarget(target)) return false;
  clearViewportRefocusSuppression();
  return true;
}

function handleViewportRefocusVisibilityChange() {
  if (document.visibilityState === 'visible') {
    clearViewportRefocusSuppression();
    state.ui.pendingAppRefocusSuppression = false;
    return;
  }
  if (document.visibilityState === 'hidden') {
    state.ui.pendingAppRefocusSuppression = false;
  }
}

function suppressRefocusViewportInteraction(event) {
  const now = Date.now();
  if (!isViewportRefocusSuppressionActive(now)) {
    return false;
  }
  state.ui.suppressNextViewportClick = false;
  state.ui.suppressClickSequenceUntil = now + VIEWPORT_REFOCUS_SUPPRESSION_GRACE_MS;
  resetViewportRefocusIntentTracking();
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  return true;
}

function suppressRefocusViewportClick(event) {
  const now = Date.now();
  if (now > Number(state.ui.suppressClickSequenceUntil || 0)) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  state.ui.suppressClickSequenceUntil = 0;
  return true;
}
