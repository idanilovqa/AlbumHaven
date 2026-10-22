'use strict';
// A local presentation owner for an explicitly synthetic trusted source in a
// bounded test, or the accepted thin Top factory's exact retained fixture host.
// Actual initiating form/modal actions must supply their own production port.
// This never intercepts the destination, manufactures registration, or grants
// source authority. The original isCurrent callback remains authoritative.
function retainedPresentation(t, h, isCurrent, id = 'trusted-origin-presentation', retainedSurface = null) {
  const surface = retainedSurface || h.add(id);
  if (!retainedSurface) surface.textContent = 'Retained trusted source';
  let suspended = null, retired = false;
  const presentation = Object.freeze({suspend() {
    if (this !== presentation || retired || suspended || !surface.isConnected || surface.hidden || surface.inert || isCurrent() !== true) return null;
    const before = {hidden: surface.hidden, inert: surface.inert, aria: surface.getAttribute('aria-hidden'),
      focus: h.document.activeElement};
    let pending = true;
    const finish = restore => {
      if (!pending) return false;
      pending = false; suspended = null;
      if (!restore) {retired = true; return true;}
      if (!surface.isConnected || isCurrent() !== true) return false;
      surface.hidden = before.hidden; surface.inert = before.inert;
      if (before.aria === null) surface.removeAttribute('aria-hidden'); else surface.setAttribute('aria-hidden', before.aria);
      if (before.focus?.isConnected && surface.contains(before.focus)) before.focus.focus();
      return true;
    };
    surface.hidden = true; surface.inert = true; surface.setAttribute('aria-hidden', 'true');
    if (before.focus && surface.contains(before.focus)) before.focus.blur?.();
    suspended = Object.freeze({restore() {return finish(true);}, retire() {return finish(false);}});
    return suspended;
  }});
  const owner = {navigation: Object.freeze({parentRegistration: null, presentation}),
    restore: () => suspended?.restore() ?? false,
    dispose() {suspended?.retire(); if (!retainedSurface) surface.remove();}};
  t.after(() => owner.dispose()); return owner;
}
module.exports = {retainedPresentation};
