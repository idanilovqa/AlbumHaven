/* A dismissal gesture never also activates the surface underneath it. */
(function (scope) {
  'use strict';
  function create(resolve) {
    let gesture = null;
    let suppressClick = false;
    const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const inside = (active, target) => active.contains ? active.contains(target)
      : active.surface.contains(target) || Boolean(active.anchor?.contains(target));
    const reset = () => { gesture = null; suppressClick = false; };
    return {
      pointerdown(event) {
        if (event.isPrimary === false) return;
        reset();
        if (event.button !== 0) return;
        const active = resolve();
        if (!active) return;
        gesture = { active, outside: !inside(active, event.target), id: event.pointerId,
          x: event.clientX, y: event.clientY };
        // Stop underlying pointer handlers and focus, not only delegated clicks.
        if (gesture.outside) consume(event);
      },
      pointerup(event) {
        if (!gesture || gesture.id !== event.pointerId) return;
        if (!gesture.outside) return;
        consume(event);
        suppressClick = true;
        const started = gesture;
        gesture = null;
        if (Math.hypot(event.clientX - started.x, event.clientY - started.y) <= 8) {
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
        if (active && !inside(active, event.target)) {
          consume(event);
          active.dismiss();
        }
      },
      pointercancel: reset,
      keydown: reset,
      blur: reset,
    };
  }
  function bind(window, resolve) {
    const handlers = create(resolve);
    for (const [type, handler] of Object.entries(handlers)) {
      window.addEventListener(type, handler, { capture: true, passive: false });
    }
    return () => {
      for (const [type, handler] of Object.entries(handlers)) window.removeEventListener(type, handler, true);
      handlers.blur();
    };
  }
  const api = { create, bind };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else scope.AlbumHavenSurfaceDismissal = api;
})(globalThis);
