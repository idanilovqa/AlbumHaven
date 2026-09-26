function getTriggerAnchorGeometry(anchor, surface) {
  const edge = surface.bottom <= anchor.top ? 'bottom' : 'top';
  return {
    edge,
    side: Math.abs(anchor.left - surface.left) <= 2 ? 'left'
      : Math.abs(surface.right - anchor.right) <= 2 ? 'right' : 'none',
    left: Math.max(0, anchor.left - surface.left),
    right: Math.max(0, surface.right - anchor.right),
    width: anchor.width,
    gap: Math.max(0, edge === 'top' ? surface.top - anchor.bottom : anchor.top - surface.bottom),
  };
}

let activeTriggerSurface = null;
function activateTriggerSurface(surface, close) {
  for (let owner = activeTriggerSurface; owner; owner = owner.parent) {
    if (owner.surface === surface) return;
  }
  while (activeTriggerSurface && !activeTriggerSurface.surface.contains?.(surface)) {
    const previous = activeTriggerSurface;
    activeTriggerSurface = previous.parent || null;
    previous.close();
  }
  activeTriggerSurface = { surface, close, parent: activeTriggerSurface };
}

const triggerAnchorBindings = new WeakMap();
function clearTriggerAnchor(surface) {
  let owner = activeTriggerSurface;
  while (owner && owner.surface !== surface) owner = owner.parent;
  if (owner) {
    while (activeTriggerSurface !== owner) {
      const child = activeTriggerSurface;
      activeTriggerSurface = child.parent;
      child.close();
    }
    activeTriggerSurface = owner.parent || null;
  }
  const binding = triggerAnchorBindings.get(surface);
  if (!binding) return;
  binding.observer?.disconnect();
 binding.resizeObserver?.disconnect();
 binding.anchor.classList.remove('trigger-anchor-open');
 surface.classList.remove('trigger-anchor-surface');
 delete binding.anchor.dataset.triggerAnchorEdge;
 delete binding.anchor.dataset.triggerAnchorContext;
 delete surface.dataset.triggerAnchorContext;
 delete surface.dataset.triggerAnchorEdge;
  delete surface.dataset.triggerAnchorSide;
  delete surface.dataset.triggerAnchorSearch;
 binding.anchor.style.removeProperty?.('--trigger-anchor-background');
 surface.style.removeProperty?.('--trigger-anchor-background');
 triggerAnchorBindings.delete(surface);
}

function syncTriggerAnchor(surface, anchor) {
  if (!surface?.getBoundingClientRect || !anchor?.getBoundingClientRect || surface.hidden) return;
  const anchorContext = anchor.closest?.('.shell-main-surface, .settings-outlet') ? 'content' : 'chrome';
  surface.dataset.triggerAnchorContext = anchorContext;
  anchor.dataset.triggerAnchorContext = anchorContext;
  activateTriggerSurface(surface, () => {
    surface.hidden = true;
    anchor.setAttribute?.('aria-expanded', 'false');
    clearTriggerAnchor(surface);
  });
  const previous = triggerAnchorBindings.get(surface);
  if (previous && previous.anchor !== anchor) clearTriggerAnchor(surface);
  const surfaceStyle = globalThis.getComputedStyle?.(surface);
  let bounds = surface.getBoundingClientRect();
  // Side drawers animate their position, not their layout width. The joined
  // outline belongs to the final layout box, not the in-flight transform.
  if (surface.matches?.('.artist-family-panel') && surfaceStyle?.transform && surfaceStyle.transform !== 'none') {
    const transform = new DOMMatrixReadOnly(surfaceStyle.transform);
    bounds = { left: bounds.left - transform.m41, right: bounds.right - transform.m41,
      top: bounds.top - transform.m42, bottom: bounds.bottom - transform.m42 };
  }
  const geometry = getTriggerAnchorGeometry(anchor.getBoundingClientRect(), bounds);
  const renderedBackground = surfaceStyle?.backgroundColor?.trim();
  const surfaceBackground = renderedBackground
    && renderedBackground !== 'transparent'
    && renderedBackground !== 'rgba(0, 0, 0, 0)'
    // Connected surfaces must be opaque: otherwise the button's border paint
    // and the page underneath the popup produce different visible colors.
    ? renderedBackground.replace(/^(rgba\([\d.]+,\s*[\d.]+,\s*[\d.]+),\s*[\d.]+\)$/, '$1, 1)')
    : surfaceStyle?.getPropertyValue?.('--trigger-anchor-background')?.trim();
  if (surfaceBackground) {
    surface.style.setProperty('--trigger-anchor-background', surfaceBackground);
    anchor.style.setProperty('--trigger-anchor-background', surfaceBackground);
  }
  surface.classList.add('trigger-anchor-surface');
  if (anchor.matches?.('.search-field-button')) surface.dataset.triggerAnchorSearch = 'true';
  else delete surface.dataset.triggerAnchorSearch;
  anchor.classList.add('trigger-anchor-open');
 surface.dataset.triggerAnchorEdge = geometry.edge;
  surface.dataset.triggerAnchorSide = geometry.side;
  anchor.dataset.triggerAnchorEdge = geometry.edge;
  for (const name of ['left', 'right', 'width', 'gap']) {
    surface.style.setProperty(`--trigger-anchor-${name}`, `${geometry[name]}px`);
  }
  anchor.style.setProperty('--trigger-anchor-gap', `${geometry.gap}px`);
  if (previous?.anchor === anchor) return;
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
    if (surface.hidden || surface.getAttribute('aria-hidden') === 'true') clearTriggerAnchor(surface);
  }) : null;
  observer?.observe(surface, { attributes: true, attributeFilter: ['hidden', 'aria-hidden'] });
  // A sibling's animated width moves this trigger without resizing the trigger itself.
  // ResizeObserver runs after layout and before paint, keeping the join in that frame.
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (surface.hidden) { clearTriggerAnchor(surface); return; }
    syncTriggerAnchor(surface, anchor);
  }) : null;
  triggerAnchorBindings.set(surface, { anchor, observer, resizeObserver });
  if (resizeObserver) {
    resizeObserver.observe(anchor);
    resizeObserver.observe(surface);
    if (anchor.parentElement) resizeObserver.observe(anchor.parentElement);
  }
}

function syncActiveTriggerSurfaces() {
  const owners = [];
  for (let owner = activeTriggerSurface; owner; owner = owner.parent) owners.push(owner);
  owners.reverse().forEach(({ surface }) => {
    const binding = triggerAnchorBindings.get(surface);
    if (binding && !surface.hidden) syncTriggerAnchor(surface, binding.anchor);
  });
}

globalThis.addEventListener?.('resize', syncActiveTriggerSurfaces);
globalThis.addEventListener?.('scroll', syncActiveTriggerSurfaces, true);
function confinePanelTextSelection(selection, surface) {
  if (!selection?.anchorNode || !selection.focusNode || !surface.contains(selection.anchorNode)
      || surface.contains(selection.focusNode)) return;
  const bounds = surface.ownerDocument.createRange();
  bounds.selectNodeContents(surface);
  const before = bounds.comparePoint(selection.focusNode, selection.focusOffset) < 0;
  selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset,
    before ? bounds.startContainer : bounds.endContainer,
    before ? bounds.startOffset : bounds.endOffset);
}

let panelSelectionBoundaryInstalled = false;
function installPanelSelectionBoundary() {
  if (panelSelectionBoundaryInstalled) return;
  panelSelectionBoundaryInstalled = true;
  let origin = null;
  let gestureOrigin = null;
  const release = () => {
    origin?.classList.remove('panel-selection-origin');
    document.documentElement.classList.remove('panel-text-selection-active');
    origin = null;
  };
  const confine = () => {
    if (origin?.isConnected) confinePanelTextSelection(document.getSelection(), origin);
  };
  document.addEventListener('pointerdown', event => {
    release();
    gestureOrigin = event.button === 0 ? event.target.closest?.('.trigger-anchor-surface, .artist-info-overlay, [role="dialog"], [role="menu"]') : null;
    origin = event.button === 0 ? event.target.closest?.('.artist-info-overlay, .trigger-anchor-surface, .album-track-table, [role=dialog]') : null;
    if (origin) {
      origin.classList.add('panel-selection-origin');
      document.documentElement.classList.add('panel-text-selection-active');
    }
  }, true);
  // A click generated by releasing a drag outside its starting surface is not
  // an outside-click dismissal or an activation of the background underneath.
  document.addEventListener('click', event => {
    const startedInside = gestureOrigin;
    gestureOrigin = null;
    if (event.detail !== 0 && startedInside && !startedInside.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('selectionchange', confine);
  document.addEventListener('selectstart', event => {
    if (origin && !origin.contains(event.target)) event.preventDefault();
  }, true);
  document.addEventListener('pointerup', () => { confine(); release(); }, true);
  document.addEventListener('pointercancel', () => { gestureOrigin = null; release(); }, true);
  globalThis.addEventListener?.('blur', () => { gestureOrigin = null; release(); });
}
