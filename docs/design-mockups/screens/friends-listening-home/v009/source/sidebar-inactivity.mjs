/** Preview-only desktop Playlists rail policy. No routing, persistence or native layout mutation. */
export const SIDEBAR_MAIN_USE_MS = 30_000;
const browserClock = {
  now: () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: id => globalThis.clearTimeout(id),
};

/**
 * Accumulate time in the main body after an intentional main-body event.
 * Panel visits reset the budget. Other interruptions pause it and need fresh
 * main activity to resume. Repeated pointer/keyboard events never move a deadline.
 */
export function createSidebarInactivityController({ onClose, delayMs = SIDEBAR_MAIN_USE_MS,
  clock = browserClock, canClose = () => true } = {}) {
  if (typeof onClose !== 'function') throw new TypeError('Sidebar inactivity requires onClose');
  if (!Number.isFinite(delayMs) || delayMs <= 0) throw new TypeError('Sidebar delay must be positive');
  const panelUse = new Set(), blockers = new Set();
  let enabled = false, disposed = false, closed = false, elapsed = 0, startedAt = null, timer = null;
  const accumulated = () => Math.min(delayMs, elapsed + (startedAt === null ? 0 : Math.max(0, clock.now() - startedAt)));
  const stop = () => {
    elapsed = accumulated();
    startedAt = null;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  const reset = () => { stop(); elapsed = 0; closed = false; };
  const safe = () => enabled && !disposed && !closed && !panelUse.size && !blockers.size && canClose();
  const mainActivity = () => {
    if (!safe()) { stop(); return; }
    if (startedAt !== null) return;
    startedAt = clock.now();
    timer = clock.setTimeout(() => {
      stop();
      // Check actual current native state again at the deadline. If an owner
      // changed without notifying the binding, do not charge unknown blocked time.
      if (!safe()) { elapsed = 0; return; }
      if (elapsed < delayMs) { mainActivity(); return; }
      closed = true;
      onClose();
    }, Math.max(0, delayMs - elapsed));
  };
  return Object.freeze({
    mainActivity,
    leaveMain: stop,
    enterPanel(kind = 'pointer') {
      if (disposed) return;
      panelUse.add(kind);
      reset();
    },
    leavePanel(kind = 'pointer') { panelUse.delete(kind); },
    setBlocked(reason, blocked) {
      if (disposed) return;
      if (blocked) { blockers.add(reason); stop(); }
      else blockers.delete(reason);
    },
    setEnabled(value) {
      if (disposed || enabled === Boolean(value)) return;
      enabled = Boolean(value);
      reset();
    },
    reset() { if (!disposed) reset(); },
    getSnapshot: () => ({ enabled, disposed, closed, running: startedAt !== null,
      elapsedMs: accumulated(), remainingMs: delayMs - accumulated(), panelUse: [...panelUse], blockers: [...blockers] }),
    dispose() {
      if (disposed) return;
      stop(); enabled = false; disposed = true; panelUse.clear(); blockers.clear();
    },
  });
}

const overlaySelector = [
  '[aria-modal="true"]', '[role="dialog"]', '[role="menu"]', '[role="listbox"]',
  '[data-anchored-surface]', '[popover]:popover-open', 'dialog[open]',
  '.settings-foobar-format-menu', '#account-menu', '#status-context-menu',
  '#gallery-sources-menu', '#gallery-album-types-menu', '#recent-search-popover',
].join(',');
const isVisible = element => !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0;

/** Native dialogs/menus may be portaled outside both rail and main body. */
export function hasSidebarInteractionBlocker(doc) {
  // :popover-open is newer than the native client; unsupported selector engines
  // still retain all native dialog/dropdown coverage without it.
  let surfaces;
  try { surfaces = doc.querySelectorAll(overlaySelector); }
  catch { surfaces = doc.querySelectorAll(overlaySelector.replace('[popover]:popover-open,', '')); }
  return [...surfaces].some(isVisible);
}

/**
 * Bind only to an expanded desktop Playlists panel. The caller owns isEnabled
 * (mode + native folded state), native onClose, and route-lifetime cleanup.
 * refresh() handles a synchronous owner state change; reset() starts a new route
 * budget; dispose() removes every listener, observer and scheduled timeout.
 */
export function bindSidebarInactivity({ panel, main, isEnabled = () => false, onClose,
  isBlocked, delayMs = SIDEBAR_MAIN_USE_MS, clock = browserClock,
  document: doc = panel?.ownerDocument, window: view = doc?.defaultView } = {}) {
  if (!panel || !main || !doc || !view) throw new TypeError('Sidebar binding requires panel, main and their document');
  const media = view.matchMedia?.('(min-width: 901px)');
  const listeners = [], pointersDown = new Set();
  let disposed = false, blurred = false, dragging = false, captured = false, focusInPanel = false, pointerInPanel = false;
  const inPanel = target => Boolean(target && panel.contains(target));
  const inMain = target => Boolean(target && main.contains(target) && !inPanel(target));
  const desktop = () => media ? media.matches : Number(view.innerWidth) > 900;
  const eligible = () => desktop() && isEnabled() && panel.isConnected !== false && main.isConnected !== false;
  const overlays = () => Boolean(isBlocked ? isBlocked() : hasSidebarInteractionBlocker(doc));
  const safe = () => eligible() && !doc.hidden && !blurred && !dragging && !captured && !pointersDown.size
    && !inPanel(doc.activeElement) && !pointerInPanel && !overlays();
  const controller = createSidebarInactivityController({ onClose, delayMs, clock, canClose: safe });
  const setPanelPointer = value => {
    if (pointerInPanel === value) return;
    pointerInPanel = value;
    if (value) controller.enterPanel('pointer'); else controller.leavePanel('pointer');
  };
  const refresh = () => {
    if (disposed) return;
    controller.setEnabled(eligible());
    controller.setBlocked('document-hidden', Boolean(doc.hidden));
    controller.setBlocked('window-blur', blurred);
    controller.setBlocked('overlay', overlays());
    controller.setBlocked('drag', dragging || captured || pointersDown.size > 0);
    const focused = inPanel(doc.activeElement);
    if (focusInPanel !== focused) {
      focusInPanel = focused;
      if (focused) controller.enterPanel('focus'); else controller.leavePanel('focus');
    }
  };
  const activity = target => {
    refresh();
    if (inMain(target)) controller.mainActivity(); else controller.leaveMain();
  };
  const pointerActivity = event => {
    setPanelPointer(inPanel(event.target));
    if (typeof event.buttons === 'number' && event.buttons > 0) pointersDown.add(event.pointerId ?? 'mouse');
    else if (event.buttons === 0) pointersDown.delete(event.pointerId ?? 'mouse');
    activity(event.target);
  };
  const listen = (target, type, callback) => {
    target.addEventListener(type, callback, true);
    listeners.push(() => target.removeEventListener(type, callback, true));
  };
  listen(doc, 'pointerover', pointerActivity);
  listen(doc, 'pointermove', pointerActivity);
  listen(doc, 'pointerdown', event => {
    pointersDown.add(event.pointerId ?? 'mouse');
    pointerActivity(event);
  });
  listen(doc, 'pointerup', event => {
    pointersDown.delete(event.pointerId ?? 'mouse');
    setPanelPointer(inPanel(event.target));
    activity(event.target);
  });
  listen(doc, 'pointercancel', event => {
    pointersDown.delete(event.pointerId ?? 'mouse');
    controller.leaveMain(); refresh();
  });
  listen(doc, 'pointerout', event => {
    if (!event.relatedTarget) {
      setPanelPointer(false); controller.leaveMain();
    } else if (inPanel(event.target) && !inPanel(event.relatedTarget)) setPanelPointer(false);
    if (inMain(event.target) && !inMain(event.relatedTarget)) controller.leaveMain();
  });
  listen(doc, 'wheel', pointerActivity);
  listen(doc, 'keydown', event => {
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return;
    activity(event.target);
  });
  listen(doc, 'focusin', event => {
    refresh();
    // Focus alone is not activity. A subsequent main-body key or pointer event
    // arms the timer, preventing programmatic route focus from starting idle time.
    if (!inMain(event.target)) controller.leaveMain();
  });
  listen(doc, 'focusout', event => {
    if (inPanel(event.target) && !inPanel(event.relatedTarget)) {
      focusInPanel = false; controller.leavePanel('focus');
    }
    if (inMain(event.target) && !inMain(event.relatedTarget)) controller.leaveMain();
  });
  listen(doc, 'dragstart', () => { dragging = true; refresh(); });
  const endDrag = () => { dragging = false; pointersDown.clear(); controller.leaveMain(); refresh(); };
  listen(doc, 'dragend', endDrag);
  listen(doc, 'drop', endDrag);
  listen(doc, 'gotpointercapture', () => { captured = true; refresh(); });
  listen(doc, 'lostpointercapture', () => { captured = false; controller.leaveMain(); refresh(); });
  listen(doc, 'visibilitychange', () => { controller.leaveMain(); refresh(); });
  listen(view, 'blur', event => {
    if (event.target !== view) return;
    blurred = true; dragging = false; captured = false; pointersDown.clear(); setPanelPointer(false); refresh();
  });
  listen(view, 'focus', event => { if (event.target === view) { blurred = false; refresh(); } });
  listen(view, 'resize', refresh);
  const routeReset = () => { controller.reset(); refresh(); };
  listen(view, 'popstate', routeReset);
  listen(view, 'hashchange', routeReset);
  const dispose = () => {
    if (disposed) return;
    disposed = true; controller.dispose(); observer?.disconnect();
    for (const remove of listeners.splice(0)) remove();
  };
  listen(view, 'pagehide', dispose);
  if (media?.addEventListener) listen(media, 'change', refresh);
  const observer = view.MutationObserver ? new view.MutationObserver(refresh) : null;
  observer?.observe(doc.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'inert', 'aria-hidden', 'aria-expanded', 'open', 'class', 'style'] });
  setPanelPointer(Boolean(panel.matches?.(':hover')));
  refresh();
  return Object.freeze({ refresh, reset: routeReset, dispose, getSnapshot: controller.getSnapshot });
}
