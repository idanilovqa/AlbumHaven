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

function normalizeDockedCompactPlayerBehavior(value) {
  return ['follow_sidebar', 'float_on_collapse', 'artbox', 'stay_docked'].includes(value) ? value : 'follow_sidebar';
}

function resolveCompactPlayerPresentation({ eligible, mode, style, behavior, artistTreeFolded } = {}) {
  if (!eligible || mode !== 'compact') return 'expanded';
  if (normalizeCompactPlayerStyle(style) === 'floating') return 'floating';
  const dockBehavior = normalizeDockedCompactPlayerBehavior(behavior);
  if (!artistTreeFolded || dockBehavior === 'stay_docked') return 'docked';
  if (dockBehavior === 'float_on_collapse') return 'floating';
  return dockBehavior === 'artbox' ? 'rail_artbox' : 'rail_play';
}

function resolveCompactPlayerMotion({ speed, reducedMotion } = {}) {
  return reducedMotion ? { durationMs: 1, hoverDurationMs: 1 }
    : { durationMs: speed === 'slow' ? 1400 : 420, hoverDurationMs: 300 };
}

function shouldDetachCompactPlayerForOverlay({ presentation, overlayActive } = {}) {
  return Boolean(overlayActive) && ['docked', 'rail_play', 'rail_artbox'].includes(presentation);
}

function resolveCompactPlayerMetadataRevealDelay({ presentation, speed, reducedMotion } = {}) {
  if (presentation === 'rail_artbox') return 700;
  if (presentation !== 'rail_play') return null;
  return resolveCompactPlayerMotion({ speed, reducedMotion }).durationMs + 700;
}

function buildCompactPlayerMetadataSummary(track) {
  const artist = String(track?.artist || '').trim();
  const title = String(track?.title || track?.name || '').trim();
  const album = String(track?.album || '').trim();
  const song = artist && title ? `${artist} - ${title}` : artist || title;
  return song && album ? `${song} / ${album}` : song || album;
}

function resolveCompactPlayerMetadataRowMotion({ scrollWidth, clientWidth } = {}) {
  const distance = Math.max(0, Math.ceil((Number(scrollWidth) || 0) - (Number(clientWidth) || 0)));
  if (distance <= 1) return { overflowing: false, distance: 0, durationMs: 0 };
  return {
    overflowing: true,
    distance,
    durationMs: Math.max(3200, Math.round(distance * 24 + 1800)),
  };
}

function useCompactPlayerRailMode({ style, behavior, artistTreeFolded } = {}) {
  return normalizeCompactPlayerStyle(style) === 'docked'
    && normalizeDockedCompactPlayerBehavior(behavior) === 'follow_sidebar'
    && artistTreeFolded === true;
}

function canDragStayDockedCompactPlayer({ presentation, behavior, artistTreeFolded } = {}) {
  return presentation === 'docked'
    && normalizeDockedCompactPlayerBehavior(behavior) === 'stay_docked'
    && artistTreeFolded === true;
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
  normalizeDockedCompactPlayerBehavior,
  canDragStayDockedCompactPlayer,
  useCompactPlayerRailMode,
  resolveCompactPlayerPresentation,
  shouldDetachCompactPlayerForOverlay,
  resolveCompactPlayerMotion,
  resolveCompactPlayerMetadataRevealDelay,
  buildCompactPlayerMetadataSummary,
  resolveCompactPlayerMetadataRowMotion,
  didCompactPlayerDrag,
  clampCompactPlayerPosition,
  createCompactPlayerSessionPosition,
  resolveDockedCompactGeometry,
  resolveCompactQueueControls,
  shouldOpenCompactPlayerAlbum,
};
