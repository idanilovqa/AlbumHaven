/* Presentation only: navigation owns close acceptance and final disposal. */
(function (scope) {
  'use strict';
  const policy = Object.freeze({ layer: 4550, restingRatio: 0.65, minimumHeight: 192,
    intentSlop: 8, verticalRatio: 1.5, dismissRatio: 0.25,
    velocityDistance: 48, dismissVelocity: 0.5, velocityWindow: 100 });
  const mounts = new WeakMap();
  const ancestry = new WeakMap();
  const locks = new WeakMap();
  // Property-specific stacks allow out-of-order nested cleanup without restoring
  // an expired owner's value over a successor or an unrelated external write.
  function own(node, key, read, write, value) {
    if (!node) return () => {};
    let map = locks.get(node);
    if (!map) { map = new Map(); locks.set(node, map); }
    let stack = map.get(key);
    if (!stack) { stack = { base: read(), entries: [] }; map.set(key, stack); }
    const entry = { value, live: true };
    stack.entries.push(entry); write(value);
    // CSSOM canonicalizes requested text (zero units, fractional lengths, etc.).
    // Own its actual serialization, without adopting a reentrant successor.
    if (entry.live && stack.entries[stack.entries.length - 1] === entry) entry.value = read();
    return () => {
      if (!entry.live) return;
      entry.live = false;
      if (stack.entries[stack.entries.length - 1] !== entry) return;
      const stillOwned = read() === entry.value;
      while (stack.entries.length && !stack.entries[stack.entries.length - 1].live) stack.entries.pop();
      if (stillOwned) {
        const next = stack.entries[stack.entries.length - 1];
        write(next ? next.value : stack.base);
        if (next?.live && stack.entries[stack.entries.length - 1] === next) next.value = read();
      }
      if (!stack.entries.length) map.delete(key);
    };
  }
  const attr = (node, name, value) => own(node, `attr:${name}`,
    () => node.getAttribute(name), v => v === null ? node.removeAttribute(name) : node.setAttribute(name, v), value);
  const style = (node, name, value) => own(node, `style:${name}`,
    () => `${node.style.getPropertyValue(name)}|${node.style.getPropertyPriority(name)}`,
    v => { const i = v.lastIndexOf('|'); const text = v.slice(0, i);
      if (text) node.style.setProperty(name, text, v.slice(i + 1)); else node.style.removeProperty(name); }, `${value}|`);
  const inert = node => attr(node, 'inert', '');
  function sheetAncestor(node) {
    const visited = new Set();
    while (node && !visited.has(node)) {
      visited.add(node);
      const sheet = node.closest?.('.is-artist-discography-sheet, .is-native-bottom-sheet');
      if (sheet && mounts.has(sheet)) return sheet;
      node = ancestry.get(node)?.parent || node.parentElement;
    }
    return null;
  }
  function acquireChildLayer(child, parent) {
    if (!child || !parent || child === parent || parent.contains(child)) return () => {};
    const sheet = sheetAncestor(parent);
    if (!sheet || !child.isConnected || !parent.isConnected) return () => {};
    const previous = ancestry.get(child);
    const link = { parent, previous, live: true };
    ancestry.set(child, link);
    const win = child.ownerDocument.defaultView;
    let parentLayer = policy.layer;
    for (let node = parent; node; node = node.parentElement) {
      const layer = Number.parseInt(win.getComputedStyle(node).zIndex, 10);
      if (Number.isFinite(layer)) parentLayer = Math.max(parentLayer, layer);
      if (node === sheet || ancestry.has(node)) break;
    }
    const releaseLayer = style(child, 'z-index', String(Math.max(policy.layer, Number.isFinite(parentLayer) ? parentLayer : 0) + 1));
    const releaseInert = inert(parent);
    const presenter = mounts.get(sheet);
    presenter.childCount += 1;
    presenter.update();
    let released = false;
    return () => {
      if (released) return;
      released = true; link.live = false;
      if (ancestry.get(child) === link) {
        let prior = link.previous;
        while (prior && !prior.live) prior = prior.previous;
        if (prior) ancestry.set(child, prior); else ancestry.delete(child);
      }
      releaseInert(); releaseLayer();
      presenter.childCount = Math.max(0, presenter.childCount - 1);
      presenter.reconcileForeground();
      presenter.update();
    };
  }
  function mount(options) {
    const { overlay, panel, handle, scroller, toggle, readBounds, isCurrent,
      requestClose, foreground, backgroundNodes = [], ownDismissal = true, ownFocus = true,
      expandLabel = 'Expand album sheet', collapseLabel = 'Collapse album sheet' } = options;
    if (!overlay || !panel || !handle || !scroller || !toggle) throw new TypeError('Sheet presentation nodes required');
    mounts.get(overlay)?.dispose();
    const doc = overlay.ownerDocument;
    const win = doc.defaultView;
    const releases = [];
    const listeners = [];
    let disposed = false, suspended = false, releaseBackground = false, state = 'resting', snap = 'resting';
    let drag = null, bounds = null, offset = 0, frame = null, focusFrame = null, dismissalPending = false;
    let geometryReleases = [], backgroundReleases = [], toggleReleases = [];
    let backgroundHeld = false, observedHeader = null, panelInertRelease = null;
    const current = () => {
      if (disposed || mounts.get(overlay) !== controller) return false;
      const valid = Boolean(isCurrent());
      return valid && !disposed && mounts.get(overlay) === controller;
    };
    const front = () => current() && !suspended && controller.childCount === 0 && Boolean(foreground()) && current();
    const listen = (node, type, callback, settings) => {
      node.addEventListener(type, callback, settings);
      listeners.push(() => node.removeEventListener(type, callback, settings));
    };
    const releaseAll = values => { while (values.length) values.pop()(); };
    function syncPanelInert() {
      const hold = current() && (suspended || controller.childCount > 0);
      if (hold && !panelInertRelease) panelInertRelease = inert(panel);
      else if (!hold && panelInertRelease) { panelInertRelease(); panelInertRelease = null; }
    }
    function syncBackground() {
      const hold = current() && !releaseBackground;
      if (hold === backgroundHeld) return;
      backgroundHeld = hold;
      releaseAll(backgroundReleases);
      if (hold) for (const node of backgroundNodes) {
        if (node && node !== overlay && !node.contains(overlay) && !overlay.contains(node)) backgroundReleases.push(inert(node));
      }
    }
    function render() {
      frame = null;
      if (!current() || !bounds) return;
      // Restore previous token before replacing it; never accumulate per-frame locks.
      releaseAll(geometryReleases);
      geometryReleases.push(style(panel, 'height', `${Math.max(0, bounds.height - offset)}px`),
        style(panel, 'top', `${bounds.top}px`), style(panel, 'transform', `translate3d(0, ${offset}px, 0)`),
        attr(overlay, 'data-sheet-state', state));
    }
    function paint() { if (frame === null) frame = win.requestAnimationFrame(render); }
    function syncToggle() {
      releaseAll(toggleReleases);
      toggleReleases.push(attr(toggle, 'aria-expanded', String(snap === 'expanded')),
        attr(toggle, 'aria-label', snap === 'expanded' ? collapseLabel : expandLabel));
    }
    function settle(next = snap) {
      if (!current() || !bounds) return;
      snap = next; state = suspended ? 'suspended' : dismissalPending ? 'awaiting-dismissal' : snap;
      offset = snap === 'expanded' ? 0 : bounds.rest;
      syncToggle(); paint();
    }
    function cancelDrag() {
      const previous = drag; drag = null;
      if (previous?.captured && handle.hasPointerCapture?.(previous.id)) {
        try { handle.releasePointerCapture(previous.id); } catch (_) { /* Capture may already be gone. */ }
      }
      if (previous) settle();
    }
    function update() {
      if (!current()) return;
      if (!front()) cancelDrag();
      syncBackground(); syncPanelInert();
      const result = readBounds();
      if (!current()) return;
      const header = result?.header;
      const viewport = win.visualViewport;
      const viewportTop = Math.max(0, Number(viewport?.offsetTop) || 0);
      const viewportHeight = Number(viewport?.height) || win.innerHeight || doc.documentElement.clientHeight;
      const bottom = viewportTop + Math.max(0, viewportHeight);
      const headerBottom = header?.isConnected ? header.getBoundingClientRect().bottom : viewportTop;
      if (!current()) return;
      const top = Math.min(bottom, Math.max(viewportTop, headerBottom));
      const height = Math.max(0, bottom - top);
      const controlsHeight = Array.from(panel.children).filter(node => node !== scroller && !node.hidden)
        .reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
      if (!current()) return;
      const visible = Math.min(height, Math.max(policy.minimumHeight, controlsHeight, height * policy.restingRatio));
      const next = { top, height, rest: height - visible };
      if (!bounds || Object.keys(next).some(key => next[key] !== bounds[key])) {
        cancelDrag(); bounds = next; settle();
      }
      if (observer && header !== observedHeader) {
        if (observedHeader) observer.unobserve(observedHeader);
        observedHeader = header?.isConnected ? header : null;
        if (observedHeader) observer.observe(observedHeader);
      }
    }
    function begin(kind, id, x, y) {
      if (!front() || !bounds || dismissalPending) return;
      drag = { kind, id, x, y, initial: offset, startSnap: snap, claimed: false, captured: false,
        recentY: y, recentTime: win.performance.now(), velocity: 0 };
    }
    function move(x, y, event) {
      if (!drag) return;
      if (!front()) { cancelDrag(); return; }
      const dx = x - drag.x, dy = y - drag.y;
      if (!drag.claimed) {
        if (Math.abs(dx) > policy.intentSlop && Math.abs(dx) >= Math.abs(dy)) { cancelDrag(); return; }
        if (Math.abs(dy) < policy.intentSlop || Math.abs(dy) < policy.verticalRatio * Math.abs(dx)) return;
        if (drag.kind === 'touch' && dy <= 0) { cancelDrag(); return; }
        if (!event.cancelable) { cancelDrag(); return; }
        drag.claimed = true;
        if (drag.kind === 'pointer') {
          try { handle.setPointerCapture(drag.id); drag.captured = true; } catch (_) { cancelDrag(); return; }
        }
      }
      if (!event.cancelable) { cancelDrag(); return; }
      event.preventDefault();
      const now = win.performance.now();
      const elapsed = now - drag.recentTime;
      if (elapsed > 0) drag.velocity = elapsed <= policy.velocityWindow ? (y - drag.recentY) / elapsed : 0;
      drag.recentY = y; drag.recentTime = now;
      state = 'dragging'; offset = Math.max(0, Math.min(bounds.height, drag.initial + dy)); paint();
    }
    function finish() {
      if (!drag) return;
      const ended = drag;
      const destination = offset;
      const live = front();
      cancelDrag();
      if (!live || !ended.claimed) return;
      const travel = Math.max(0, destination - bounds.rest);
      const visible = Math.max(1, bounds.height - bounds.rest);
      const velocity = win.performance.now() - ended.recentTime <= policy.velocityWindow ? ended.velocity : 0;
      if (travel >= visible * policy.dismissRatio || (travel >= policy.velocityDistance && velocity >= policy.dismissVelocity)) {
        // Hold the old snap while navigation decides; veto never tears down DOM.
        requestDismissal('drag', true);
      } else settle(destination < bounds.rest / 2 ? 'expanded' : 'resting');
    }
    function requestDismissal(reason, consumeClick = false) {
      if (!front() || dismissalPending) return;
      dismissalPending = true; settle();
      if (consumeClick) dismissal.suppressNextClick();
      const rejected = () => {if (current()) {dismissalPending = false; settle();}};
      let outcome;
      try {outcome = requestClose(reason);} catch (_error) {rejected(); return;}
      if (outcome === false) {rejected(); return;}
      if (outcome && typeof outcome.then === 'function') {
        Promise.resolve(outcome).then(accepted => {if (accepted === false) rejected();}, rejected);
      }
      // Undefined/history.go return is not settlement. Only actual navigation
      // rejection re-enables input; accepted cleanup disposes this owner.
    }
    function eligibleContent(target) {
      if (!target || !scroller.contains(target) || scroller.scrollTop > 1) return false;
      if (target.closest?.('a,button,input,select,textarea,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="slider"],label')) return false;
      for (let node = target; node && node !== scroller; node = node.parentElement) {
        const css = win.getComputedStyle(node);
        if (/(auto|scroll)/.test(css.overflowY) && node.scrollHeight > node.clientHeight) return false;
      }
      return true;
    }
    function focusables() {
      return Array.from(panel.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')).filter(node =>
        !node.disabled && node.tabIndex >= 0 && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length);
    }
    const controller = { childCount: 0, update,
      reconcileForeground() {
        if (!current()) return;
        const foregroundNow = Boolean(foreground());
        if (current()) controller.suspend(!foregroundNow);
      },
      expand() { if (front() && !dismissalPending) { cancelDrag(); settle('expanded'); } },
      collapse() { if (front() && !dismissalPending) { cancelDrag(); settle('resting'); } },
      suspend(value = true, settings = {}) {
        if (!current()) return;
        cancelDrag(); suspended = Boolean(value);
        if (!suspended) releaseBackground = false;
        else if (Object.prototype.hasOwnProperty.call(settings, 'releaseBackground')) releaseBackground = Boolean(settings.releaseBackground);
        settle(); syncBackground(); syncPanelInert();
      },
      dispose() {
        if (disposed) return;
        // Invalidate first; no callback can reenter an outgoing owner.
        disposed = true;
        cancelDrag();
        if (frame !== null) win.cancelAnimationFrame(frame);
        if (focusFrame !== null) win.cancelAnimationFrame(focusFrame);
        observer?.disconnect();
        dismissal();
        if (panelInertRelease) { panelInertRelease(); panelInertRelease = null; }
        releaseAll(listeners); releaseAll(toggleReleases); releaseAll(geometryReleases);
        releaseAll(backgroundReleases); releaseAll(releases);
        if (mounts.get(overlay) === controller) mounts.delete(overlay);
      } };
    mounts.set(overlay, controller);
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(update) : null;
    const dismissal = ownDismissal ? scope.AlbumHavenSurfaceDismissal.bind(win, () => front() ? {
      surface: panel, isBackdrop: target => target === overlay,
      dismiss: () => requestDismissal('backdrop')
    } : null) : () => {};
    releases.push(attr(handle, 'hidden', null), attr(toggle, 'hidden', null),
      attr(panel, 'role', 'dialog'), attr(panel, 'aria-modal', 'true'));
    listen(handle, 'pointerdown', event => {
      if (event.isPrimary === false || event.button !== 0) { cancelDrag(); return; }
      if (drag) { cancelDrag(); return; }
      begin('pointer', event.pointerId, event.clientX, event.clientY);
    });
    listen(win, 'pointermove', event => { if (drag?.kind === 'pointer' && drag.id === event.pointerId) move(event.clientX, event.clientY, event); }, { passive: false });
    listen(win, 'pointerup', event => { if (drag?.kind === 'pointer' && drag.id === event.pointerId) finish(); });
    listen(win, 'pointercancel', cancelDrag);
    listen(handle, 'lostpointercapture', cancelDrag);
    listen(scroller, 'touchstart', event => {
      if (event.touches.length !== 1) { cancelDrag(); return; }
      if (drag || !eligibleContent(event.target)) return;
      const touch = event.touches[0]; begin('touch', touch.identifier, touch.clientX, touch.clientY);
    }, { passive: true });
    // Registered narrowly on the content owner before intent, but prevents native
    // scrolling only for the claimed, still-cancelable, downward single touch.
    listen(scroller, 'touchmove', event => {
      if (event.touches.length !== 1) { cancelDrag(); return; }
      if (drag?.kind !== 'touch') return;
      const touch = event.touches[0];
      if (touch.identifier !== drag.id) { cancelDrag(); return; }
      move(touch.clientX, touch.clientY, event);
    }, { passive: false });
    listen(scroller, 'touchend', event => { if (drag?.kind === 'touch') { if (event.touches.length) cancelDrag(); else finish(); } });
    listen(scroller, 'touchcancel', cancelDrag);
    listen(win, 'touchstart', event => { if (event.touches.length > 1) cancelDrag(); }, { passive: true, capture: true });
    listen(win, 'blur', event => { if (event.target === win) cancelDrag(); });
    const viewportChanged = () => { cancelDrag(); update(); };
    listen(win, 'resize', viewportChanged); listen(win, 'orientationchange', viewportChanged);
    if (win.visualViewport) { listen(win.visualViewport, 'resize', viewportChanged); listen(win.visualViewport, 'scroll', viewportChanged); }
    listen(toggle, 'click', () => { if (snap === 'expanded') controller.collapse(); else controller.expand(); });
    listen(doc, 'keydown', event => {
      if (!ownFocus || event.key !== 'Tab' || !front()) return;
      const nodes = focusables();
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); panel.focus({ preventScroll: true }); return; }
      if (event.shiftKey && (doc.activeElement === first || !panel.contains(doc.activeElement))) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && (doc.activeElement === last || !panel.contains(doc.activeElement))) { event.preventDefault(); first.focus({ preventScroll: true }); }
    });
    releases.push(attr(panel, 'tabindex', '-1'));
    observer?.observe(panel);
    update(); syncToggle();
    focusFrame = win.requestAnimationFrame(() => {
      focusFrame = null;
      if (!ownFocus || !front() || panel.contains(doc.activeElement)) return;
      const close = panel.querySelector('[data-close-track-modal]');
      if (front()) (close || focusables()[0] || panel).focus({ preventScroll: true });
    });
    return Object.freeze({ update, expand: controller.expand, collapse: controller.collapse,
      suspend: controller.suspend, dispose: controller.dispose });
  }
  const api = Object.freeze({ mount, acquireChildLayer, policy });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.AlbumHavenBottomSheet = api;
})(globalThis);
