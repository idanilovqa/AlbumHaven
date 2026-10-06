/** Presentation only. The caller retains state, history, focus, scroll, and
 * native component ownership; this controller never copies or retains DOM. */
export function createWidgetMotion({document, commit, surfaces, media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'), onError = error => globalThis.reportError?.(error)}) {
  const duration = 240, easing = 'cubic-bezier(.2,.8,.2,1)';
  let revision = 0, applying = false, pending = null;
  const live = new Set();
  const read = () => surfaces().filter(({node}) => node?.isConnected && node.getClientRects().length);
  const measure = () => new Map(read().map(surface => {
    const opacity = Number.parseFloat(document.defaultView?.getComputedStyle(surface.node).opacity);
    return [surface.key, {...surface, rect:surface.node.getBoundingClientRect(), opacity:Number.isFinite(opacity) ? opacity : 1}];
  }));
  function stopLive() { for (const animation of live) animation.cancel(); live.clear(); }
  function cleanup(record) {
    if (record.cleaned) return;
    record.cleaned = true;
    for (const [node, previous] of record.names) {
      if (previous.value) node.style.setProperty('view-transition-name', previous.value, previous.priority);
      else node.style.removeProperty('view-transition-name');
    }
    record.names.clear();
    if (pending === record) {
      delete document.documentElement.dataset.mockWidgetMotion;
      delete document.documentElement.dataset.mockWidgetMotionAxis;
      pending = null;
    }
  }
  function invalidate() {
    // route()/native owners may invalidate while the approved change commits.
    if (applying) return;
    revision++;
    stopLive();
    if (pending) { pending.transition?.skipTransition(); cleanup(pending); }
  }
  function nameSurfaces(record) {
    // Rehosting may choose a different outer surface, but never duplicates the
    // live native Album/Artist owner. Restore prior names before assigning new.
    for (const [node, previous] of record.names) {
      if (previous.value) node.style.setProperty('view-transition-name', previous.value, previous.priority);
      else node.style.removeProperty('view-transition-name');
    }
    record.names.clear();
    for (const {key, node} of read()) {
      record.names.set(node, {value:node.style.getPropertyValue('view-transition-name'), priority:node.style.getPropertyPriority('view-transition-name')});
      node.style.setProperty('view-transition-name', key);
    }
  }
  function glide(before) {
    if (media?.matches) return;
    for (const {key, node, rect, axis = 'inline'} of measure().values()) {
      if (!node.animate) continue;
      const previous = before.get(key), old = previous?.rect;
      const x = old ? old.left - rect.left : axis === 'inline' ? 24 : 0;
      const y = old ? old.top - rect.top : axis === 'block' ? 24 : 0;
      const sx = old && rect.width ? old.width / rect.width : 1;
      const sy = old && rect.height ? old.height / rect.height : 1;
      if (old && Math.abs(x) < .5 && Math.abs(y) < .5 && Math.abs(sx - 1) < .001 && Math.abs(sy - 1) < .001 && previous.opacity >= .999) continue;
      const animation = node.animate([
        {transform:`translate(${x}px,${y}px) scale(${sx},${sy})`, transformOrigin:'top left', opacity:old ? previous.opacity : 0},
        {transform:'none', transformOrigin:'top left', opacity:1},
      ], {duration, easing});
      live.add(animation);
      animation.finished.catch(() => {}).then(() => live.delete(animation));
    }
  }
  function run(change, {atomic = false, motion = true, axis = 'inline'} = {}) {
    if (applying) return change();
    // Read the current visual position before cancelling a live glide. A newer
    // selection starts there and always owns the only subsequent state commit.
    const before = motion && !media?.matches ? measure() : new Map();
    invalidate();
    const token = revision;
    let committed = false;
    const apply = () => {
      if (committed || token !== revision) return false;
      committed = true;
      applying = true;
      try { commit(change); } finally { applying = false; }
      return true;
    };
    // Popstate presentation must finish synchronously, before the native owner
    // restores its scroll/focus. Animate only its already-committed geometry.
    if (atomic || !motion || media?.matches || !document.startViewTransition) {
      if (apply() && motion) glide(before);
      return;
    }
    const record = {names:new Map(), cleaned:false, transition:null};
    pending = record;
    document.documentElement.dataset.mockWidgetMotion = 'true';
    document.documentElement.dataset.mockWidgetMotionAxis = axis;
    nameSurfaces(record);
    try {
      record.transition = document.startViewTransition(() => {
        if (apply() && pending === record) nameSurfaces(record);
      });
    } catch (error) {
      cleanup(record);
      if (apply()) glide(before);
      else if (token === revision) onError(error);
      return;
    }
    // A skipped transition still invokes its callback. The revision guard is
    // therefore required even after skipTransition(), including rapid history.
    record.transition.ready.catch(() => {});
    record.transition.updateCallbackDone.catch(onError);
    record.transition.finished.catch(() => {}).then(() => cleanup(record));
  }
  const reduce = () => {
    if (!media?.matches) return;
    stopLive();
    // Skip presentation, not the requested state change that may still await
    // the browser's capture callback. Do not invalidate its revision here.
    pending?.transition?.skipTransition();
  };
  media?.addEventListener?.('change', reduce);
  return {run, invalidate, dispose() { invalidate(); media?.removeEventListener?.('change', reduce); }};
}
