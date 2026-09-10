const COMPACT_PLAYER_MODE_STORAGE_KEY = 'albumhaven.compactPlayer.mode.v1';

function isCompactPlayerEligible({ viewportWidth, desktopBreakpoint = 900 } = {}) {
  return Number(viewportWidth) > Number(desktopBreakpoint);
}

function resolveCompactPlayerMode({ eligible, persistedMode } = {}) {
  return eligible && persistedMode === 'compact' ? 'compact' : 'expanded';
}

function persistCompactPlayerMode(storage, mode) {
  if (!['compact', 'expanded'].includes(mode) || !storage?.setItem) return false;
  try { storage.setItem(COMPACT_PLAYER_MODE_STORAGE_KEY, mode); return true; } catch (_error) { return false; }
}

function normalizeCompactPlayerStyle(value) {
  return value === 'floating' ? 'floating' : 'docked';
}

function didCompactPlayerDrag({ startX, startY, currentX, currentY, threshold = 6 } = {}) {
  return Math.hypot(Number(currentX) - Number(startX), Number(currentY) - Number(startY)) >= Number(threshold);
}

function clampCompactPlayerPosition(options = {}) {
  const margin = Math.max(0, Number(options.margin) || 0);
  const leftMargin = Math.max(margin, Number(options.leftMargin) || 0);
  const maximumX = Math.max(leftMargin, Number(options.viewportWidth) - Number(options.playerWidth) - margin);
  const maximumY = Math.max(margin, Number(options.viewportHeight) - Number(options.playerHeight) - margin);
  return {
    x: Math.max(leftMargin, Math.min(Number(options.x) || 0, maximumX)),
    y: Math.max(margin, Math.min(Number(options.y) || 0, maximumY)),
  };
}

function createCompactPlayerSessionPosition(options = {}) {
  return clampCompactPlayerPosition({
    ...options,
    x: Number(options.leftMargin ?? options.margin ?? 0),
    y: Number(options.viewportHeight) - Number(options.playerHeight) - Number(options.margin || 0),
  });
}

function resolveDockedCompactGeometry(treeRect = {}) {
  return {
    left: Number(treeRect.left) || 0,
    width: Math.max(0, Number(treeRect.width) || 0),
  };
}

function resolveCompactQueueControls({ queueLength, currentIndex } = {}) {
  const length = Math.max(0, Number(queueLength) || 0);
  const index = Number(currentIndex);
  return {
    previousDisabled: length < 1 || index <= 0,
    nextDisabled: length < 1 || index < 0 || index >= length - 1,
  };
}

function shouldOpenCompactPlayerAlbum({ style, eventType, detail = 0 } = {}) {
  if (eventType === 'dblclick') return style === 'floating';
  if (eventType === 'click') return style !== 'floating' || Number(detail) === 0;
  return false;
}

if (typeof module !== 'undefined' && module.exports) module.exports = {
  COMPACT_PLAYER_MODE_STORAGE_KEY,
  isCompactPlayerEligible,
  resolveCompactPlayerMode,
  persistCompactPlayerMode,
  normalizeCompactPlayerStyle,
  didCompactPlayerDrag,
  clampCompactPlayerPosition,
  createCompactPlayerSessionPosition,
  resolveDockedCompactGeometry,
  resolveCompactQueueControls,
  shouldOpenCompactPlayerAlbum,
};
