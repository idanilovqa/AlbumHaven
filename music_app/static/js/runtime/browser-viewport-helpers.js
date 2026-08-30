function getViewportSize() {
  return {
    width: Number(window?.innerWidth || 0),
    height: Number(window?.innerHeight || 0),
  };
}

function getViewportScrollPosition() {
  return {
    x: Number(window?.scrollX || 0),
    y: Number(window?.scrollY || 0),
  };
}

function clampPositionToViewport(left, top, rectWidth, rectHeight, padding = 0) {
  const viewport = getViewportSize();
  const safePadding = Math.max(0, Number(padding) || 0);
  const maxLeft = Math.max(safePadding, viewport.width - Number(rectWidth || 0) - safePadding);
  const maxTop = Math.max(safePadding, viewport.height - Number(rectHeight || 0) - safePadding);
  return {
    left: Math.min(Math.max(safePadding, Number(left) || 0), maxLeft),
    top: Math.min(Math.max(safePadding, Number(top) || 0), maxTop),
  };
}
