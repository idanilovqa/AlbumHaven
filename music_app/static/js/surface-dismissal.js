/* A dismissal gesture never also activates the surface underneath it. */
(function (scope) {
  'use strict';
  function create(resolve, onSuppress = () => {}) {
    let gesture = null;
    let suppressClick = false;
    let refocusPending = false;
    const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const inside = (active, target) => active.contains ? active.contains(target)
      : active.surface.contains(target) || Boolean(active.anchor?.contains(target));
    const backdrop = (active, target) => Boolean(active.isBackdrop?.(target));
    const reset = () => { gesture = null; suppressClick = false; };
    const arm = () => { suppressClick = true; onSuppress(); };
    return {
      suppressNextClick: arm,
      hasPendingClick: () => suppressClick,
      pointerdown(event) {
        if (event.isPrimary === false) return;
        reset();
        if (event.button !== 0) return;
        const active = resolve();
        if (!active) return;
        gesture = { active, outside: !inside(active, event.target), id: event.pointerId,
          x: event.clientX, y: event.clientY };
        gesture.dismissOnly = gesture.outside && backdrop(active, event.target);
        gesture.refocusOnly = gesture.dismissOnly && refocusPending;
        refocusPending = false;
        // Stop underlying pointer handlers and focus, not only delegated clicks.
        if (gesture.dismissOnly) consume(event);
      },
      pointerup(event) {
        if (!gesture || gesture.id !== event.pointerId) return;
        if (!gesture.dismissOnly) return;
        consume(event);
        arm();
        const started = gesture;
        gesture = null;
        if (!started.refocusOnly
            && Math.hypot(event.clientX - started.x, event.clientY - started.y) <= 8) {
          // Preserve the pending click guard while the owner's close callback may
          // synchronously click an internal Cancel button to settle a promise.
          started.active.dismiss();
        }
      },
      click(event) {
        if (event.detail !== 0 && suppressClick) {
          consume(event); reset(); return;
        }
        const started = gesture;
        gesture = null;
        if (event.detail !== 0 && started && !started.outside
            && !inside(started.active, event.target)) {
          consume(event); return;
        }
        const active = resolve();
        if (refocusPending) {
          refocusPending = false;
          if (active && !inside(active, event.target) && backdrop(active, event.target)) {
            consume(event); return;
          }
        }
        if (active && !inside(active, event.target) && backdrop(active, event.target)) {
          consume(event);
          active.dismiss();
        }
      },
      pointercancel: reset,
      keydown() { refocusPending = false; reset(); },
      blur() { reset(); refocusPending = Boolean(resolve()); },
    };
  }
  function bind(window, resolve) {
    let disposed = false;
    let expiry = null;
    let tail = false;
    const clearTail = () => {
      if (expiry !== null) window.clearTimeout(expiry);
      expiry = null;
      if (!tail) return;
      tail = false;
      window.removeEventListener('click', tailClick, true);
      window.removeEventListener('pointerdown', clearTail, true);
      window.removeEventListener('keydown', clearTail, true);
      window.removeEventListener('blur', tailBlur, true);
    };
    const tailBlur = event => { if (event.target === window) clearTail(); };
    const tailClick = event => {
      if (event.detail === 0) return;
      event.preventDefault(); event.stopImmediatePropagation(); clearTail();
    };
    const handlers = create(resolve, () => {
      if (expiry !== null) window.clearTimeout(expiry);
      expiry = window.setTimeout(() => { clearTail(); handlers.pointercancel(); }, 1000);
    });
    // Only actual event names are installed. Controller methods are not events.
    const listeners = {};
    for (const type of ['pointerdown', 'pointerup', 'click', 'pointercancel', 'keydown']) {
      listeners[type] = handlers[type];
    }
    listeners.blur = event => {
      if (event.target === window) handlers.blur();
    };
    for (const [type, handler] of Object.entries(listeners)) {
      window.addEventListener(type, handler, { capture: true, passive: false });
    }
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const [type, handler] of Object.entries(listeners)) window.removeEventListener(type, handler, true);
      if (handlers.hasPendingClick()) {
        // Keep only the bounded one-shot tail, even across synchronous teardown.
        tail = true;
        window.addEventListener('click', tailClick, { capture: true, passive: false });
        window.addEventListener('pointerdown', clearTail, true);
        window.addEventListener('keydown', clearTail, true);
        window.addEventListener('blur', tailBlur, true);
      } else clearTail();
    };
    dispose.suppressNextClick = () => { if (!disposed) handlers.suppressNextClick(); };
    return dispose;
  }

  const api = { create, bind };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.AlbumHavenSurfaceDismissal = api;
})(globalThis);
