let compactPlayerMode = 'expanded';
let compactPlayerStyle = 'docked';
let compactPlayerDrag = null;
let compactPlayerPosition = null;
let compactPlayerSuppressClick = false;
let compactPlayerPendingSelection = null;
const FLOATING_COMPACT_PLAYER_MARGIN = 4;
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

function syncDockedCompactGeometry() {
  const els = compactPlayerElements();
  const tree = document.getElementById('shell-navigation-rail');
  if (!els.player || !tree) return;
  const geometry = resolveDockedCompactGeometry(tree.getBoundingClientRect());
  if (geometry.width <= 0) return;
  els.player.style.setProperty('--compact-docked-left', `${geometry.left}px`);
  els.player.style.setProperty('--compact-docked-width', `${geometry.width}px`);
}

function applyCompactPlayerMode(mode, { persist = true } = {}) {
  const els = compactPlayerElements();
  const next = resolveCompactPlayerMode({ eligible: compactPlayerEligible(), persistedMode: mode });
  const previousStyle = compactPlayerStyle;
  compactPlayerMode = next;
  compactPlayerStyle = getCompactPlayerStyle();
  const compact = next === 'compact';
  document.documentElement.classList.toggle('has-compact-player', compact);
  document.documentElement.classList.toggle('has-docked-compact-player', compact && compactPlayerStyle === 'docked');
  document.documentElement.classList.toggle('has-floating-compact-player', compact && compactPlayerStyle === 'floating');
  els.player?.classList.toggle('is-compact', compact);
  els.player?.classList.toggle('is-floating-compact', compact && compactPlayerStyle === 'floating');
  els.player?.classList.toggle('is-docked-compact', compact && compactPlayerStyle === 'docked');
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
  if (els.expand) els.expand.hidden = !compactPlayerEligible();
  if (compact && compactPlayerStyle === 'docked') syncDockedCompactGeometry();
  if (compact && compactPlayerStyle === 'floating') {
    if (!compactPlayerPosition || previousStyle !== 'floating') resetCompactPlayerPosition();
    else {
      compactPlayerPosition = clampCompactPlayerPosition({ ...compactPlayerPosition, playerWidth: 96, playerHeight: 96,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, margin: FLOATING_COMPACT_PLAYER_MARGIN,
        leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN });
      els.player.style.setProperty('--compact-player-x', `${compactPlayerPosition.x}px`);
      els.player.style.setProperty('--compact-player-y', `${compactPlayerPosition.y}px`);
    }
  }
  if (persist) persistCompactPlayerMode(window.localStorage, next);
  syncCompactPlayerUi();
}

function resetCompactPlayerPosition() {
  const els = compactPlayerElements();
  if (!els.player) return;
  compactPlayerPosition = createCompactPlayerSessionPosition({
    playerWidth: 96, playerHeight: 96,
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
  if (els.cover) {
    els.cover.style.backgroundImage = track?.coverPath
      ? `url('/cover?path=${encodeURIComponent(track.coverPath)}')`
      : '';
    els.cover.classList.toggle('is-idle-placeholder', !track);
    els.cover.disabled = !track;
    const openLabel = compactPlayerStyle === 'floating' ? 'Double-click to open album details' : 'Open album details';
    els.cover.setAttribute('aria-label', openLabel);
    els.cover.title = openLabel;
  }
  if (els.play) {
    els.play.textContent = playback.paused ? '▶' : '⏸';
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
  try { saved = window.localStorage.getItem(COMPACT_PLAYER_MODE_STORAGE_KEY) || 'expanded'; } catch (_error) {}
  applyCompactPlayerMode(saved, { persist: false });
  els.collapse?.addEventListener('click', () => applyCompactPlayerMode('compact'));
  els.expand?.addEventListener('click', () => applyCompactPlayerMode('expanded'));
  els.play?.addEventListener('click', () => togglePlayerPlayback());
  els.previous?.addEventListener('click', () => playCompactQueueOffset(-1));
  els.next?.addEventListener('click', () => playCompactQueueOffset(1));
  const openCurrentAlbumDetails = () => {
    const album = resolveAlbumForPlayerTrack(state.player.current);
    if (album) openTrackModal(album, { coverLightboxGallery: false });
  };
  els.cover?.addEventListener('click', event => {
    if (compactPlayerSuppressClick) { event.preventDefault(); compactPlayerSuppressClick = false; return; }
    if (!shouldOpenCompactPlayerAlbum({ style: compactPlayerStyle, eventType: event.type, detail: event.detail })) return;
    openCurrentAlbumDetails();
  });
  els.cover?.addEventListener('dblclick', event => {
    if (!shouldOpenCompactPlayerAlbum({ style: compactPlayerStyle, eventType: event.type, detail: event.detail })) return;
    event.preventDefault();
    openCurrentAlbumDetails();
  });
  els.cover?.addEventListener('pointerdown', event => {
    if (compactPlayerStyle !== 'floating') return;
    compactPlayerDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originX: compactPlayerPosition?.x || 0, originY: compactPlayerPosition?.y || 0, didDrag: false };
    els.player.classList.add('is-compact-player-dragging');
    els.cover.setPointerCapture?.(event.pointerId);
  });
  els.cover?.addEventListener('pointermove', event => {
    if (!compactPlayerDrag || compactPlayerDrag.pointerId !== event.pointerId) return;
    if (!compactPlayerDrag.didDrag) compactPlayerDrag.didDrag = didCompactPlayerDrag({ ...compactPlayerDrag, currentX: event.clientX, currentY: event.clientY });
    if (!compactPlayerDrag.didDrag) return;
    compactPlayerPosition = clampCompactPlayerPosition({ x: compactPlayerDrag.originX + event.clientX - compactPlayerDrag.startX,
      y: compactPlayerDrag.originY + event.clientY - compactPlayerDrag.startY, playerWidth: 96, playerHeight: 96,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, margin: FLOATING_COMPACT_PLAYER_MARGIN,
      leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN });
    els.player.style.setProperty('--compact-player-x', `${compactPlayerPosition.x}px`);
    els.player.style.setProperty('--compact-player-y', `${compactPlayerPosition.y}px`);
  });
  const finishDrag = event => {
    const completedDrag = event.type === 'pointerup' && Boolean(compactPlayerDrag?.didDrag);
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
      try { savedMode = window.localStorage.getItem(COMPACT_PLAYER_MODE_STORAGE_KEY) || 'expanded'; } catch (_error) {}
      applyCompactPlayerMode(savedMode, { persist: false });
    } else if (compactPlayerStyle === 'floating' && compactPlayerPosition) {
      compactPlayerPosition = clampCompactPlayerPosition({ ...compactPlayerPosition, playerWidth: 96, playerHeight: 96,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, margin: FLOATING_COMPACT_PLAYER_MARGIN,
        leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN });
      els.player.style.setProperty('--compact-player-x', `${compactPlayerPosition.x}px`);
      els.player.style.setProperty('--compact-player-y', `${compactPlayerPosition.y}px`);
    } else if (compactPlayerStyle === 'docked') {
      syncDockedCompactGeometry();
    }
  });
  window.addEventListener('album-haven-appearance-change', () => {
    applyCompactPlayerMode(compactPlayerMode, { persist: false });
  });
}
