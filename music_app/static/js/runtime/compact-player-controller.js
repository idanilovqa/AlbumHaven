let compactPlayerMode = 'expanded';
let compactPlayerStyle = 'docked';
let dockedCompactPlayerBehavior = 'follow_sidebar';
let compactPlayerPresentation = 'expanded';
let compactPlayerArtClickTimer = null;
let compactPlayerMetadataRevealTimer = null;
let compactPlayerMetadataMeasureFrame = null;
let compactPlayerTrackKey = null;
let compactPlayerDrag = null;
let compactPlayerPosition = null;
let stayDockedPlayerPosition = null;
let stayDockedPlayerOrigin = null;
let stayDockedPlayerWasFolded = false;
let compactPlayerSuppressClick = false;
let compactPlayerPendingSelection = null;
const FLOATING_COMPACT_PLAYER_MARGIN = 8;
const FLOATING_COMPACT_PLAYER_LEFT_MARGIN = 12;

function compactPlayerElements() {
  const player = document.querySelector('.global-player');
  const expanded = player?.querySelector('.player-shell');
  const compact = player?.querySelector('.compact-player-shell');
  const compactControlRoot = compact?.querySelector('[data-playback-control-cluster]');
  const compactControls = getPlaybackControlClusterElements(compactControlRoot);
  return {
    player,
    expanded,
    compact,
    collapse: expanded?.querySelector("[data-ui-button-action='player-collapse']"),
    expand: compact?.querySelector("[data-ui-button-action='player-expand']"),
    cover: player?.querySelector('[data-compact-player-cover]'),
    hoverBubble: compact?.querySelector('[data-compact-player-hover-bubble]'),
    summary: compact?.querySelector('[data-compact-player-summary]'),
    albumSeparator: compact?.querySelector('[data-compact-player-album-separator]'),
    albumLink: compact?.querySelector('[data-compact-player-album]'),
    titleRow: compact?.querySelector('[data-compact-player-title]'),
    titleText: compact?.querySelector('[data-compact-player-title-text]'),
    artistRow: compact?.querySelector('[data-compact-player-artist]'),
    artistText: compact?.querySelector('[data-compact-player-artist-text]'),
    play: compactControls.playPause,
    previous: compactControls.previous,
    next: compactControls.next,
  };
}

function compactPlayerEligible() {
  return isCompactPlayerEligible({ viewportWidth: window.innerWidth, desktopBreakpoint: 900 });
}

function getCompactPlayerStyle() {
  const applied = document.documentElement.getAttribute('data-compact-player-style');
  if (applied) return normalizeCompactPlayerStyle(applied);
  const bootstrap = document.getElementById('appearance-bootstrap');
  try { return normalizeCompactPlayerStyle(JSON.parse(bootstrap?.textContent || '{}').compact_player_style); }
  catch (_error) { return 'docked'; }
}

function getDockedCompactPlayerBehavior() {
  const applied = document.documentElement.getAttribute('data-docked-compact-player-behavior');
  if (applied) return normalizeDockedCompactPlayerBehavior(applied);
  const bootstrap = document.getElementById('appearance-bootstrap');
  try { return normalizeDockedCompactPlayerBehavior(JSON.parse(bootstrap?.textContent || '{}').docked_compact_player_behavior); }
  catch (_error) { return 'follow_sidebar'; }
}

function clearCompactPlayerArtClick() {
  window.clearTimeout(compactPlayerArtClickTimer);
  compactPlayerArtClickTimer = null;
}

function hideCompactPlayerMetadata(els = compactPlayerElements()) {
  window.clearTimeout(compactPlayerMetadataRevealTimer);
  compactPlayerMetadataRevealTimer = null;
  els.player?.classList.remove('is-compact-metadata-visible');
  if (els.hoverBubble) {
    els.hoverBubble.setAttribute('aria-hidden', 'true');
    els.hoverBubble.inert = true;
  }
}

function scheduleCompactPlayerMetadata(els = compactPlayerElements()) {
  hideCompactPlayerMetadata(els);
  const delay = resolveCompactPlayerMetadataRevealDelay({
    presentation: compactPlayerPresentation,
    speed: document.documentElement.getAttribute('data-compact-player-motion'),
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  });
  if (delay === null || !els.summary?.textContent || els.play?.disabled) return;
  compactPlayerMetadataRevealTimer = window.setTimeout(() => {
    compactPlayerMetadataRevealTimer = null;
    if (!['rail_play', 'rail_artbox'].includes(compactPlayerPresentation)) return;
    els.player?.classList.add('is-compact-metadata-visible');
    if (els.hoverBubble) {
      els.hoverBubble.setAttribute('aria-hidden', 'false');
      els.hoverBubble.inert = false;
    }
  }, delay);
}

function refreshCompactPlayerMetadataRows(els = compactPlayerElements()) {
  const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  for (const [row, text] of [[els.titleRow, els.titleText], [els.artistRow, els.artistText]]) {
    if (!row || !text) continue;
    const motion = compactPlayerPresentation === 'docked' && !reducedMotion
      ? resolveCompactPlayerMetadataRowMotion({ scrollWidth: text.scrollWidth, clientWidth: row.clientWidth })
      : { overflowing: false, distance: 0, durationMs: 0 };
    row.classList.toggle('is-overflowing', motion.overflowing);
    row.style.setProperty('--compact-player-row-pan-distance', `${motion.distance}px`);
    row.style.setProperty('--compact-player-row-pan-duration', `${motion.durationMs}ms`);
  }
}

function scheduleCompactPlayerMetadataRowRefresh(els = compactPlayerElements()) {
  if (compactPlayerMetadataMeasureFrame !== null) {
    window.cancelAnimationFrame?.(compactPlayerMetadataMeasureFrame);
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    refreshCompactPlayerMetadataRows(els);
    return;
  }
  compactPlayerMetadataMeasureFrame = window.requestAnimationFrame(() => {
    compactPlayerMetadataMeasureFrame = null;
    refreshCompactPlayerMetadataRows(els);
  });
}

function resetStayDockedPlayerPosition(els = compactPlayerElements()) {
  stayDockedPlayerPosition = null;
  stayDockedPlayerOrigin = null;
  els.player?.style.setProperty('--stay-docked-drag-x', '0px');
  els.player?.style.setProperty('--stay-docked-drag-y', '0px');
}

function cancelCompactPlayerDrag(els = compactPlayerElements()) {
  const captureTarget = compactPlayerDrag?.captureTarget;
  const pointerId = compactPlayerDrag?.pointerId;
  try {
    if (captureTarget?.hasPointerCapture?.(pointerId)) captureTarget.releasePointerCapture(pointerId);
  } catch (_error) {}
  compactPlayerDrag = null;
  els.player?.classList.remove('is-compact-player-dragging');
}

function syncDockedCompactGeometry() {
  const { player } = compactPlayerElements();
  const tree = document.getElementById('shell-navigation-rail');
  if (!player || !tree) return;
  const geometry = tree.getBoundingClientRect();
  if (geometry.width <= 0) return;
  player.style.setProperty('--compact-docked-left', `${geometry.left}px`);
}

function syncCompactPlayerOverlayDetachment(els = compactPlayerElements()) {
  els.player?.classList.toggle('is-overlay-detached', shouldDetachCompactPlayerForOverlay({
    presentation: compactPlayerPresentation,
    overlayActive: document.body?.classList?.contains('modal-open'),
  }));
}

function syncDockedCompactPresentation(els = compactPlayerElements()) {
  const artistTreeFolded = Boolean(document.getElementById('app-shell')?.classList?.contains('is-artist-tree-folded'));
  const dockBehavior = getDockedCompactPlayerBehavior();
  const basePresentation = resolveCompactPlayerPresentation({
    eligible: compactPlayerEligible(), mode: compactPlayerMode, style: compactPlayerStyle,
    behavior: dockBehavior, artistTreeFolded,
  });
  const next = document.body?.classList?.contains('modal-open') && basePresentation === 'rail_artbox'
    ? 'rail_play'
    : basePresentation;
  const stayDockedFolded = canDragStayDockedCompactPlayer({
    presentation: next, behavior: dockBehavior, artistTreeFolded,
  });
  const changed = next !== compactPlayerPresentation;
  if (changed || (stayDockedPlayerWasFolded && !stayDockedFolded)) {
    clearCompactPlayerArtClick();
    hideCompactPlayerMetadata(els);
    els.player?.classList.remove('is-compact-art-revealed');
    cancelCompactPlayerDrag(els);
  }
  if (stayDockedPlayerWasFolded && !stayDockedFolded) resetStayDockedPlayerPosition(els);
  stayDockedPlayerWasFolded = stayDockedFolded;
  compactPlayerPresentation = next;
  syncCompactPlayerOverlayDetachment(els);
  const compact = next !== 'expanded';
  const floating = next === 'floating';
  const rail = next === 'rail_play' || next === 'rail_artbox';
  document.documentElement.classList.toggle('has-follow-sidebar-compact-player', rail);
  document.documentElement.classList.toggle('has-docked-compact-player', compact && !floating);
  document.documentElement.classList.toggle('has-floating-compact-player', floating);
  els.player?.classList.toggle('is-rail-compact', rail);
  els.player?.classList.toggle('is-floating-compact', floating);
  els.player?.classList.toggle('is-docked-compact', compact && !floating);
  els.player?.classList.toggle('is-stay-docked-draggable', stayDockedFolded);
  if (els.player) {
    els.player.dataset.compactPresentation = next;
  }
  if (els.expand) els.expand.hidden = !floating;
  if (els.cover) {
    const artHidden = next === 'rail_play' && !els.player?.classList.contains('is-compact-art-revealed');
    els.cover.inert = artHidden;
    els.cover.tabIndex = artHidden ? -1 : 0;
    if (changed && ((document.activeElement === els.cover && artHidden)
      || (document.activeElement === els.expand && els.expand?.hidden))) {
      (els.play?.disabled ? document.getElementById('artist-tree-navigation-button') : els.play)?.focus?.({ preventScroll: true });
    }
  }
  document.documentElement.style.setProperty('--compact-player-width',
    floating ? '96px' : rail ? '64px' : '240px');
  syncDockedCompactGeometry();
  if (floating) {
    if (!compactPlayerPosition) resetCompactPlayerPosition();
    else positionFloatingCompactPlayer();
  }
  syncCompactPlayerUi();
}

function positionFloatingCompactPlayer() {
  if (!compactPlayerPosition) return;
  compactPlayerPosition = clampCompactPlayerPosition({ ...compactPlayerPosition,
    playerWidth: 105, playerHeight: 105, viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight, margin: FLOATING_COMPACT_PLAYER_MARGIN,
    leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN });
  const { player } = compactPlayerElements();
  player?.style.setProperty('--compact-player-x', `${compactPlayerPosition.x}px`);
  player?.style.setProperty('--compact-player-y', `${compactPlayerPosition.y}px`);
}

function applyCompactPlayerMode(mode, { persist = true, transferFocus = true } = {}) {
  const els = compactPlayerElements();
  const next = resolveCompactPlayerMode({ eligible: compactPlayerEligible(), persistedMode: mode });
  compactPlayerMode = next;
  compactPlayerStyle = getCompactPlayerStyle();
  dockedCompactPlayerBehavior = getDockedCompactPlayerBehavior();
  const compact = next === 'compact';
  const outgoing = compact ? els.expanded : els.compact;
  const outgoingFocus = outgoing?.contains?.(document.activeElement) ? document.activeElement : null;
  // Pointer activation should not leave a focus highlight on the new mode.
  // Keyboard and responsive changes still rescue focus from the inert shell.
  if (outgoingFocus && !transferFocus) outgoingFocus.blur();
  document.documentElement.classList.toggle('has-compact-player', compact);
  document.documentElement.classList.toggle('has-docked-compact-player', compact && compactPlayerStyle === 'docked');
  document.documentElement.classList.toggle('has-floating-compact-player', compact && compactPlayerStyle === 'floating');
  els.player?.classList.toggle('is-compact', compact);
  els.player?.classList.toggle('is-floating-compact', compact && compactPlayerStyle === 'floating');
  els.player?.classList.toggle('is-docked-compact', compact && compactPlayerStyle === 'docked');
  syncDockedCompactPresentation(els, compact);
  if (els.expanded) {
    els.expanded.hidden = false;
    els.expanded.inert = compact;
    els.expanded.setAttribute('aria-hidden', String(compact));
  }
  if (els.compact) {
    els.compact.hidden = false;
    els.compact.inert = !compact;
    els.compact.setAttribute('aria-hidden', String(!compact));
  }
  if (els.collapse) els.collapse.hidden = !compactPlayerEligible();
  if (els.expand) els.expand.hidden = compactPlayerPresentation !== 'floating';
  if (persist) {
    try {
      persistCompactPlayerMode(window.localStorage, next);
    } catch (_error) {
      // Browser policy may deny access to the storage object itself.
    }
  }
  if (outgoingFocus && transferFocus) {
    const incoming = compact ? els.compact : els.expanded;
    const modeControl = compact ? els.expand : els.collapse;
    const focusTarget = modeControl && !modeControl.hidden && !modeControl.disabled
      ? modeControl : incoming?.querySelector('[data-playback-control-action="play-pause"]');
    if (focusTarget && !focusTarget.hidden && !focusTarget.disabled) {
      focusTarget.focus({ preventScroll: true });
    } else if (incoming) {
      incoming.setAttribute('tabindex', '-1');
      incoming.focus({ preventScroll: true });
    }
  }
}

function resetCompactPlayerPosition() {
  const els = compactPlayerElements();
  if (!els.player) return;
  compactPlayerPosition = createCompactPlayerSessionPosition({
    playerWidth: 105, playerHeight: 105,
    viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, margin: FLOATING_COMPACT_PLAYER_MARGIN,
    leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN,
  });
  els.player.style.setProperty('--compact-player-x', `${compactPlayerPosition.x}px`);
  els.player.style.setProperty('--compact-player-y', `${compactPlayerPosition.y}px`);
}

function isCurrentCompactQueueSelection(selection) {
  const queue = state.player.playbackQueue;
  return Boolean(selection && compactPlayerPendingSelection === selection
    && selection.queue === queue && queue.currentIndex === selection.index
    && String(queue.tracks?.[selection.index]?.path || '') === selection.path);
}

function currentQueueIndex() {
  const queue = state.player.playbackQueue;
  if (isCurrentCompactQueueSelection(compactPlayerPendingSelection)) {
    return compactPlayerPendingSelection.index;
  }
  compactPlayerPendingSelection = null;
  if (!queue?.tracks?.length) return -1;
  const path = String(state.player.current?.path || '');
  const found = queue.tracks.findIndex(track => String(track?.path || '') === path);
  return found >= 0 ? found : Number(queue.currentIndex) || 0;
}

async function playCompactQueueOffset(offset) {
  const queue = state.player.playbackQueue;
  const index = currentQueueIndex();
  if (!queue?.tracks?.length || index < 0) return;
  const targetIndex = index + offset;
  if (targetIndex < 0 || targetIndex >= queue.tracks.length) return;
  const track = queue.tracks[targetIndex];
  const selection = { queue, index: targetIndex, path: String(track?.path || '') };
  compactPlayerPendingSelection = selection;
  queue.currentIndex = targetIndex;
  let started = false;
  try {
    const playbackStart = playTrackFromPayload(track);
    syncCompactPlayerUi();
    started = await playbackStart;
    return started;
  } catch (error) {
    if (isCurrentCompactQueueSelection(selection)) {
      if (typeof observeStreamingFacadeCallback === 'function') {
        observeStreamingFacadeCallback(Promise.reject(error), 'compact-track-selection-start-error');
      } else {
        console.warn('[AlbumHaven][Playback] Compact track selection failed.', error);
      }
    }
    return false;
  } finally {
    if (compactPlayerPendingSelection === selection) {
      const ownsQueueCursor = isCurrentCompactQueueSelection(selection);
      compactPlayerPendingSelection = null;
      if (!started && ownsQueueCursor) {
        const playingPath = String(state.player.current?.path || '');
        const playingIndex = queue.tracks.findIndex(item => String(item?.path || '') === playingPath);
        queue.currentIndex = playingIndex >= 0 ? playingIndex : index;
      }
      syncCompactPlayerUi();
    }
  }
}

function syncCompactPlayerUi(snapshot = {}) {
  const els = compactPlayerElements();
  if (!els.player) return;
  const playback = snapshot.playback || getPlayerPlaybackSnapshot();
  const track = snapshot.displayTrack || state.player.current;
  const hasTrack = snapshot.hasTrack ?? Boolean(track && (playback.src || track.src));
  const locked = snapshot.lockedByAnotherTab ?? (typeof isPlaybackLockedByAnotherTab === 'function' && isPlaybackLockedByAnotherTab());
  const trackKey = track?.path || null;
  if (trackKey !== compactPlayerTrackKey) {
    clearCompactPlayerArtClick();
    hideCompactPlayerMetadata(els);
  }
  compactPlayerTrackKey = trackKey;
  if (els.titleText) els.titleText.textContent = track?.title || track?.name || 'Nothing playing';
  if (els.artistText) els.artistText.textContent = track?.artist || '';
  const summary = buildCompactPlayerMetadataSummary(track ? { ...track, album: '' } : null);
  const album = String(track?.album || '').trim();
  if (els.summary) els.summary.textContent = summary;
  if (els.albumSeparator) els.albumSeparator.hidden = !summary || !album;
  if (els.albumLink) {
    els.albumLink.textContent = album;
    els.albumLink.hidden = !album;
  }
  scheduleCompactPlayerMetadataRowRefresh(els);
  if (els.cover) {
    els.cover.style.backgroundImage = track?.coverPath
      ? `url("/cover?path=${encodeURIComponent(track.coverPath)}")`
      : '';
    els.cover.classList.toggle('is-idle-placeholder', !track);
    els.cover.disabled = !track && !['docked', 'rail_artbox'].includes(compactPlayerPresentation);
    const openLabel = compactPlayerPresentation === 'floating' ? 'Double-click to open album details' : 'Expand player; double-click or Arrow Up for album details';
    els.cover.setAttribute('aria-label', openLabel);
  }
  if (els.play) {
    els.play.querySelector('.compact-player-play-icon path')?.setAttribute('d', playback.paused ? 'M8 5v14l12-7z' : 'M6 5h4v14H6zM14 5h4v14h-4z');
    els.play.setAttribute('aria-label', playback.paused ? 'Play' : 'Pause');
    els.play.disabled = !hasTrack || locked;
  }
  const queue = state.player.playbackQueue;
  const controls = resolveCompactQueueControls({ queueLength: queue?.tracks?.length || 0, currentIndex: currentQueueIndex() });
  if (els.previous) els.previous.disabled = controls.previousDisabled || locked;
  if (els.next) els.next.disabled = controls.nextDisabled || locked;
}

function initCompactPlayer() {
  const els = compactPlayerElements();
  if (!els.player || els.player.dataset.compactBound === '1') return;
  els.player.dataset.compactBound = '1';
  let saved = 'expanded';
  try { saved = (window.AlbumHavenDevicePreferences?.enabled ? window.AlbumHavenDevicePreferences : window.localStorage).getItem(COMPACT_PLAYER_MODE_STORAGE_KEY) || 'expanded'; } catch (_error) {}
  applyCompactPlayerMode(saved, { persist: false });
  if (typeof MutationObserver === 'function' && document.body) {
    new MutationObserver(() => syncDockedCompactPresentation(els))
      .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  if (typeof ResizeObserver === 'function') {
    const metadataResizeObserver = new ResizeObserver(() => scheduleCompactPlayerMetadataRowRefresh(els));
    for (const row of [els.titleRow, els.artistRow]) if (row) metadataResizeObserver.observe(row);
  }
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  reducedMotion?.addEventListener?.('change', () => scheduleCompactPlayerMetadataRowRefresh(els));
  els.collapse?.addEventListener('click', (event) => applyCompactPlayerMode('compact', { transferFocus: !(event.detail > 0) }));
  els.expand?.addEventListener('click', (event) => applyCompactPlayerMode('expanded', { transferFocus: !(event.detail > 0) }));
  els.play?.addEventListener('click', () => togglePlayerPlayback());
  els.previous?.addEventListener('click', () => playCompactQueueOffset(-1));
  els.next?.addEventListener('click', () => playCompactQueueOffset(1));
  const openCurrentAlbumDetails = () => {
    const album = resolveAlbumForPlayerTrack(state.player.current);
    if (album) openTrackModal(album, { coverLightboxGallery: false, foreground: true });
  };
  els.albumLink?.addEventListener('click', openCurrentAlbumDetails);
  els.cover?.addEventListener('click', event => {
    if (compactPlayerSuppressClick) { event.preventDefault(); compactPlayerSuppressClick = false; return; }
    if (compactPlayerPresentation !== 'floating') {
      clearCompactPlayerArtClick();
      if (event.detail === 0) applyCompactPlayerMode('expanded');
      else if (event.detail === 1) compactPlayerArtClickTimer = window.setTimeout(() => {
        compactPlayerArtClickTimer = null;
        applyCompactPlayerMode('expanded', { transferFocus: false });
      }, 300);
      return;
    }
    if (!shouldOpenCompactPlayerAlbum({ style: compactPlayerPresentation, eventType: event.type, detail: event.detail })) return;
    openCurrentAlbumDetails();
  });
  els.cover?.addEventListener('dblclick', event => {
    clearCompactPlayerArtClick();
    event.preventDefault();
    openCurrentAlbumDetails();
  });
  els.cover?.addEventListener('keydown', event => {
    if (['docked', 'rail_artbox'].includes(compactPlayerPresentation) && event.key === 'ArrowUp') {
      event.preventDefault();
      clearCompactPlayerArtClick();
      openCurrentAlbumDetails();
    }
  });
  const revealArt = visible => {
    if (compactPlayerPresentation !== 'rail_play' || !els.cover) return;
    els.player.classList.toggle('is-compact-art-revealed', visible);
    if (!visible && document.activeElement === els.cover) els.play?.focus?.({ preventScroll: true });
    els.cover.inert = !visible;
    els.cover.tabIndex = visible ? 0 : -1;
  };
  els.play?.addEventListener('pointerenter', () => {
    revealArt(true);
    scheduleCompactPlayerMetadata(els);
  });
  els.compact?.addEventListener('pointerleave', () => {
    hideCompactPlayerMetadata(els);
    revealArt(els.compact.contains(document.activeElement) && document.activeElement?.matches?.(':focus-visible'));
  });
  els.compact?.addEventListener('focusin', event => {
    if (event.target.matches?.(':focus-visible')) {
      revealArt(true);
      if (event.target === els.play) scheduleCompactPlayerMetadata(els);
    }
  });
  els.compact?.addEventListener('focusout', event => {
    if (!els.compact.contains(event.relatedTarget)) {
      hideCompactPlayerMetadata(els);
      revealArt(false);
    }
  });
  window.addEventListener('pagehide', () => {
    clearCompactPlayerArtClick();
    hideCompactPlayerMetadata(els);
    if (compactPlayerMetadataMeasureFrame !== null) window.cancelAnimationFrame?.(compactPlayerMetadataMeasureFrame);
    compactPlayerMetadataMeasureFrame = null;
  });
  els.compact?.addEventListener('pointerdown', event => {
    if (!els.player.classList.contains('is-stay-docked-draggable') || event.button !== 0) return;
    if (event.target.closest?.('button, a, input, select, textarea, [role="button"], [data-compact-player-cover]')) return;
    event.preventDefault();
    const rect = els.player.getBoundingClientRect();
    if (!stayDockedPlayerOrigin) stayDockedPlayerOrigin = { x: rect.x, y: rect.y };
    const position = stayDockedPlayerPosition || { x: rect.x, y: rect.y };
    compactPlayerDrag = {
      kind: 'stay_docked', pointerId: event.pointerId, captureTarget: els.compact,
      startX: event.clientX, startY: event.clientY, originX: position.x, originY: position.y,
      playerWidth: rect.width, playerHeight: rect.height, didDrag: false,
    };
    els.compact.setPointerCapture?.(event.pointerId);
  });
  els.compact?.addEventListener('pointermove', event => {
    if (compactPlayerDrag?.kind !== 'stay_docked' || compactPlayerDrag.pointerId !== event.pointerId) return;
    if (!compactPlayerDrag.didDrag) {
      compactPlayerDrag.didDrag = didCompactPlayerDrag({
        ...compactPlayerDrag, currentX: event.clientX, currentY: event.clientY,
      });
      if (compactPlayerDrag.didDrag) els.player.classList.add('is-compact-player-dragging');
    }
    if (!compactPlayerDrag.didDrag) return;
    event.preventDefault();
    stayDockedPlayerPosition = clampCompactPlayerPosition({
      x: compactPlayerDrag.originX + event.clientX - compactPlayerDrag.startX,
      y: compactPlayerDrag.originY + event.clientY - compactPlayerDrag.startY,
      playerWidth: compactPlayerDrag.playerWidth, playerHeight: compactPlayerDrag.playerHeight,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      margin: FLOATING_COMPACT_PLAYER_MARGIN,
    });
    els.player.style.setProperty('--stay-docked-drag-x', `${stayDockedPlayerPosition.x - stayDockedPlayerOrigin.x}px`);
    els.player.style.setProperty('--stay-docked-drag-y', `${stayDockedPlayerPosition.y - stayDockedPlayerOrigin.y}px`);
  });
  const finishStayDockedDrag = event => {
    if (compactPlayerDrag?.kind !== 'stay_docked' || compactPlayerDrag.pointerId !== event.pointerId) return;
    cancelCompactPlayerDrag(els);
  };
  els.compact?.addEventListener('pointerup', finishStayDockedDrag);
  els.compact?.addEventListener('pointercancel', finishStayDockedDrag);
  els.cover?.addEventListener('pointerdown', event => {
    if (compactPlayerPresentation !== 'floating' || event.button !== 0) return;
    compactPlayerDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      kind: 'floating', captureTarget: els.cover,
      originX: compactPlayerPosition?.x || 0, originY: compactPlayerPosition?.y || 0, didDrag: false };
    els.player.classList.add('is-compact-player-dragging');
    els.cover.setPointerCapture?.(event.pointerId);
  });
  els.cover?.addEventListener('pointermove', event => {
    if (compactPlayerDrag?.kind !== 'floating' || compactPlayerDrag.pointerId !== event.pointerId) return;
    if (!compactPlayerDrag.didDrag) compactPlayerDrag.didDrag = didCompactPlayerDrag({ ...compactPlayerDrag, currentX: event.clientX, currentY: event.clientY });
    if (!compactPlayerDrag.didDrag) return;
    compactPlayerPosition = clampCompactPlayerPosition({ x: compactPlayerDrag.originX + event.clientX - compactPlayerDrag.startX,
      y: compactPlayerDrag.originY + event.clientY - compactPlayerDrag.startY, playerWidth: 105, playerHeight: 105,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, margin: FLOATING_COMPACT_PLAYER_MARGIN,
      leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN });
    els.player.style.setProperty('--compact-player-x', `${compactPlayerPosition.x}px`);
    els.player.style.setProperty('--compact-player-y', `${compactPlayerPosition.y}px`);
  });
  const finishDrag = event => {
    if (compactPlayerDrag?.kind !== 'floating' || compactPlayerDrag.pointerId !== event.pointerId) return;
    const completedDrag = event.type === 'pointerup' && Boolean(compactPlayerDrag.didDrag);
    try {
      if (compactPlayerDrag?.pointerId === event.pointerId && els.cover.hasPointerCapture?.(event.pointerId)) {
        els.cover.releasePointerCapture?.(event.pointerId);
      }
    } finally {
      compactPlayerSuppressClick = completedDrag;
      compactPlayerDrag = null;
      els.player.classList.remove('is-compact-player-dragging');
    }
  };
  els.cover?.addEventListener('pointerup', finishDrag);
  els.cover?.addEventListener('pointercancel', finishDrag);
  window.addEventListener('resize', () => {
    if (!compactPlayerEligible()) applyCompactPlayerMode('expanded', { persist: false });
    else if (compactPlayerMode === 'expanded') {
      let savedMode = 'expanded';
      try { savedMode = (window.AlbumHavenDevicePreferences?.enabled ? window.AlbumHavenDevicePreferences : window.localStorage).getItem(COMPACT_PLAYER_MODE_STORAGE_KEY) || 'expanded'; } catch (_error) {}
      applyCompactPlayerMode(savedMode, { persist: false });
    } else if (compactPlayerPresentation === 'floating' && compactPlayerPosition) {
      compactPlayerPosition = clampCompactPlayerPosition({ ...compactPlayerPosition, playerWidth: 105, playerHeight: 105,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, margin: FLOATING_COMPACT_PLAYER_MARGIN,
        leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN });
      els.player.style.setProperty('--compact-player-x', `${compactPlayerPosition.x}px`);
      els.player.style.setProperty('--compact-player-y', `${compactPlayerPosition.y}px`);
    } else if (compactPlayerStyle === 'docked') {
      syncDockedCompactPresentation();
    }
  });
  window.addEventListener('album-haven-appearance-change', () => {
    applyCompactPlayerMode(compactPlayerMode, { persist: false });
  });
}
