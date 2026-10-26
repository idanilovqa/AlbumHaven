// The persistent player owns only three measured rows. Audio ticks do not replace
// their nodes or restart animation; ResizeObserver handles width/font changes.
let globalPlayerMetadataMotion = null;
function syncGlobalPlayerMetadataMotion(els, mobile) {
  const rows = [els.artist, els.title, els.albumLink].filter(row => row?.ownerDocument?.createElement);
  if (!rows.length || typeof window === 'undefined') return;
  if (!mobile) {
    globalPlayerMetadataMotion?.dispose();
    globalPlayerMetadataMotion = null;
    return;
  }
  if (!globalPlayerMetadataMotion) {
    const entries = new Map();
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let disposed = false;
    const refresh = () => {
      frame = 0;
      for (const [row, text] of entries) {
        const motion = !media?.matches && !row.hidden
          ? resolveCompactPlayerMetadataRowMotion({ scrollWidth: text.scrollWidth, clientWidth: row.clientWidth })
          : { overflowing: false, distance: 0, durationMs: 0 };
        row.classList.toggle('is-metadata-overflowing', motion.overflowing);
        row.style.setProperty('--player-metadata-distance', `${motion.distance}px`);
        row.style.setProperty('--player-metadata-duration', `${motion.durationMs}ms`);
      }
    };
    const schedule = () => {
      if (!disposed && !frame) frame = window.requestAnimationFrame(refresh);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    media?.addEventListener?.('change', schedule);
    window.addEventListener('resize', schedule, { passive: true });
    document.fonts?.ready.then(schedule);
    globalPlayerMetadataMotion = {
      update(row) {
        let text = row.querySelector('[data-player-metadata-text]');
        if (!text) {
          text = row.ownerDocument.createElement('span');
          text.setAttribute('data-player-metadata-text', '');
          text.textContent = row.textContent;
          row.replaceChildren(text);
        }
        if (entries.get(row) === text) return;
        const previous = entries.get(row);
        if (previous) observer?.unobserve(previous);
        entries.set(row, text);
        observer?.observe(row);
        observer?.observe(text);
        schedule();
      },
      dispose() {
        disposed = true;
        if (frame) window.cancelAnimationFrame(frame);
        observer?.disconnect();
        media?.removeEventListener?.('change', schedule);
        window.removeEventListener('resize', schedule);
        for (const row of entries.keys()) {
          row.classList.remove('is-metadata-overflowing');
          row.style.removeProperty('--player-metadata-distance');
          row.style.removeProperty('--player-metadata-duration');
        }
        entries.clear();
      },
    };
  }
  rows.forEach(row => globalPlayerMetadataMotion.update(row));
}

function renderGlobalPlayerMetadata(els, track) {
  const mobile = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  const setText = (row, text) => {
    if (!row) return;
    if (row.textContent !== text) row.textContent = text;
    if (mobile) row.setAttribute?.('title', text);
    else row.removeAttribute?.('title');
  };
  if (els.artist) {
    els.artist.hidden = !mobile || !track;
    setText(els.artist, track?.artist || '');
  }
  const parts = (mobile ? [track?.title] : [track?.artist, track?.title]).filter(Boolean);
  setText(els.title, parts.length ? `${parts.join(' - ')}${!mobile && track?.album ? ' /' : ''}` : '');
  if (els.albumLink) {
    setText(els.albumLink, track?.album || '');
    els.albumLink.hidden = !track?.album;
  }
  syncGlobalPlayerMetadataMotion(els, mobile);
}


function clampLoopTimes() {
  const duration = getPlayerDuration() || 0;
  const max = duration > 0 ? duration : Math.max(state.player.loopEnd, 30);
  state.player.loopStart = Math.max(0, Math.min(Number(state.player.loopStart) || 0, Math.max(0, max - 0.1)));
  state.player.loopEnd = Math.max(state.player.loopStart + 0.1, Math.min(Number(state.player.loopEnd) || max, max));
}

function isoNow() {
  return new Date().toISOString();
}

function unixNowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function getPlayerDuration() {
  const editDuration = Number(state.player.loopEditDurationSeconds);
  if (state.player.loopActive && Number.isFinite(editDuration) && editDuration > 0) return editDuration;
  const playbackDuration = Number(getPlayerPlaybackSnapshot().duration);
  if (Number.isFinite(playbackDuration) && playbackDuration > 0) {
    // Top payloads retain their exact fresh resolver provenance. The measured
    // clock remains the presentation duration; do not rewrite that DTO/alias.
    if (state.player.current && !(typeof TopPlaybackRuntime !== 'undefined'
      && TopPlaybackRuntime.hasBinding(state.player.current))) state.player.current.durationSeconds = playbackDuration;
    return playbackDuration;
  }
  const currentDuration = Number(state.player.current?.durationSeconds);
  return Number.isFinite(currentDuration) && currentDuration > 0 ? currentDuration : 0;
}

function getTimelineSecondsFromClientX(clientX) {
  const els = getPlayerElements();
  const wrap = els.timeline?.getBoundingClientRect();
  const duration = getPlayerDuration() || Math.max(state.player.loopEnd, 0.1);
  if (!wrap || wrap.width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (clientX - wrap.left) / wrap.width));
  return ratio * duration;
}

function updateLoopInputsFromState() {
  const els = getPlayerElements();
  const duration = getPlayerDuration() || Math.max(state.player.loopEnd, 30);
  const max = Math.max(0.1, duration);
  const reconciledRange = els.loopRange?._loopRangeController?.render({
    startSeconds: state.player.loopStart,
    endSeconds: state.player.loopEnd,
  });
  if (reconciledRange) {
    state.player.loopStart = reconciledRange.startSeconds;
    state.player.loopEnd = reconciledRange.endSeconds;
  }
  if (els.timeline) els.timeline.max = String(max);
  if (els.loopStartInput && document.activeElement !== els.loopStartInput) {
    els.loopStartInput.value = formatLoopTime(state.player.loopStart, true);
  }
  if (els.loopEndInput && document.activeElement !== els.loopEndInput) {
    els.loopEndInput.value = formatLoopTime(state.player.loopEnd, true);
  }
}

function renderGlobalPlayerPlayGlyph(button, paused) {
  const icon = paused ? 'play' : 'pause';
  if (button.getAttribute('data-player-glyph') === icon) return;
  button.innerHTML = window.ButtonComponent.renderIconSvg(icon, { className: 'player-transport-icon' });
  button.setAttribute('data-player-glyph', icon);
}

function updatePlayerUi() {
  const els = getPlayerElements();
  const playback = getPlayerPlaybackSnapshot();
  const lockedByAnotherTab = typeof isPlaybackLockedByAnotherTab === 'function' && isPlaybackLockedByAnotherTab();
  const mirroredTrack = lockedByAnotherTab && typeof getMirroredPlaybackTrack === 'function'
    ? getMirroredPlaybackTrack()
    : null;
  const displayTrack = lockedByAnotherTab ? (mirroredTrack || { title: 'Playing in another tab', artist: '', album: '' }) : state.player.current;
  if (lockedByAnotherTab) invalidatePlaybackPresentation();
  else if (state.player.coverWasOwnershipLocked) refreshPlayerCover(state.player.current);
  state.player.lastKnownWasPlaying = Boolean(!lockedByAnotherTab && !playback.paused && !playback.ended);
  const hasTrack = Boolean(displayTrack && (lockedByAnotherTab || playback.src || state.player.current?.src));
  els.player?.classList?.toggle('is-empty', !hasTrack);
  const emptyMessage = els.player?.querySelector?.('[data-player-empty-message]');
  if (emptyMessage) emptyMessage.hidden = hasTrack;
  const duration = getPlayerDuration();
  const dragPreview = Number(state.player.timelineDragPreviewSeconds);
  const current = state.player.timelineDragging && Number.isFinite(dragPreview)
    ? dragPreview
    : Number(playback.currentTime) || 0;
  if (els.timeline) {
    els.timeline.max = String(Math.max(duration, 0.1));
    els.timeline.value = String(Math.min(current, duration || current));
    els.timeline.style?.setProperty('--player-seek-progress', `${duration > 0 ? Math.max(0, Math.min(100, current / duration * 100)) : 0}%`);
    els.timeline.disabled = !hasTrack || lockedByAnotherTab;
  }
  if (els.time) {
    els.time.hidden = !hasTrack;
    els.time.textContent = state.player.loopActive
      ? `${formatLoopTime(state.player.loopStart, true)} - ${formatLoopTime(state.player.loopEnd, true)}`
      : lockedByAnotherTab
      ? 'Playing in another tab'
      : `${formatLoopTime(current)} / ${formatLoopTime(duration)}`;
  }
  els.loopActions?._loopActionController?.update({
    enabled: Boolean(getPlayerPlaybackSnapshot().src || state.player.current?.src),
    canCreate: state.loopCreateAllowed === true,
    contextKey: state.player.current?.path || state.player.current?.src || '',
    active: state.player.loopActive,
    busy: state.player.saveBusy || lockedByAnotherTab,
  });
  if (els.play) {
    renderGlobalPlayerPlayGlyph(els.play, playback.paused);
    els.play.setAttribute('aria-label', lockedByAnotherTab ? 'Playback locked in another tab' : (playback.paused ? 'Play' : 'Pause'));
    els.play.disabled = lockedByAnotherTab || !hasTrack;
  }
  if (isPlaybackLockedByAnotherTab() !== lockedByAnotherTab) return updatePlayerUi();
  if (typeof syncCompactPlayerUi === 'function') syncCompactPlayerUi({ displayTrack, playback, hasTrack, lockedByAnotherTab });
  els.timeline?.parentElement?.classList.toggle('is-looping', state.player.loopActive);
  if (els.timeline?.parentElement) {
    els.timeline.parentElement.classList.toggle('is-idle', !hasTrack || lockedByAnotherTab);
    els.timeline.parentElement.setAttribute('data-idle-label', lockedByAnotherTab ? 'Playing in another tab' : 'Nothing is playing');
  }
  if (els.loopRegion) els.loopRegion.hidden = !state.player.loopActive;
  if (els.loopStartHandle) els.loopStartHandle.hidden = !state.player.loopActive;
  if (els.loopEndHandle) els.loopEndHandle.hidden = !state.player.loopActive;
  const loopRangeSurface = els.loopRange?.querySelector('[data-loop-range-surface]');
  if (loopRangeSurface) loopRangeSurface.hidden = !state.player.loopActive;
  if (isPlaybackLockedByAnotherTab() !== lockedByAnotherTab) return updatePlayerUi();
  renderGlobalPlayerMetadata(els, displayTrack);
  updateLoopInputsFromState();
  updateWaveformAppearance();
  const compactPeaks = state.player.waveform?.compactPeaks?.data;
  if (state.player.loopActive && els.waveformCanvas && compactPeaks) {
    const progress = duration > 0 ? current / duration : 0;
    drawWaveformOnCanvas(els.waveformCanvas, compactPeaks, progress);
  }
  refreshTrackModalPlaybackState();
  refreshNonAlbumModalPlaybackState();
  persistPlayerState();
  try {window.AlbumHavenTrackPlayback?.sync();} catch { /* Optional paint must never interrupt native playback. */ }
}

function setCurrentPlayerTrack(track, options = {}) {
  const current = () => (!options.isCurrent || options.isCurrent() === true)
    && !isPlaybackLockedByAnotherTab();
  if (!current()) return;
  const els = getPlayerElements();
  const previousTrack = state.player.current;
  const previousTrackId = getTrackIdentity(previousTrack);
  const nextTrackId = getTrackIdentity(track);
  const previousSession = state.player.listenSession;
  const previousPlaybackSnapshot = options.previousPlaybackSnapshot || null;
  if (previousTrack && previousTrackId && previousTrackId !== nextTrackId && previousSession) {
    void finalizeListenSession('track-change', {
      session: previousSession,
      currentTime: Number(previousPlaybackSnapshot?.currentTime) || undefined,
      duration: Number(previousPlaybackSnapshot?.duration) || undefined,
    });
  }
  if (!current()) return;
  if (!isPlaybackLockedByAnotherTab() && track && !String(track.coverPath || '').trim() && typeof resolveAlbumForPlayerTrack === 'function') {
    const resolvedCoverPath = String(resolveAlbumForPlayerTrack(track)?.cover_path || '').trim();
    if (resolvedCoverPath) {
      const decorated = { ...track, coverPath: resolvedCoverPath };
      if (track.albumListeningIntent && typeof bindAlbumListeningIntent === 'function') bindAlbumListeningIntent(decorated, track.albumListeningIntent);
      if (typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasBinding(track)
        && !TopPlaybackRuntime.alias(track, decorated)) return;
      track = decorated;
    }
  }
  if (!current()) return;
  state.player.current = track;
  if (typeof ExplicitQueueRuntime !== 'undefined') ExplicitQueueRuntime.currentChanged();
  if (!current() || state.player.current !== track) return;
  state.player.timelineDragging = false;
  state.player.timelineDragPreviewSeconds = null;
  if (typeof probeCachedWaveformPeaks === 'function') {
    const cachedWaveformProbe = probeCachedWaveformPeaks(
      String(track?.path || ''),
      Number(state.player.streaming?.generation) || 0,
    );
    if (cachedWaveformProbe && typeof cachedWaveformProbe.catch === 'function') {
      void cachedWaveformProbe.catch(() => {});
    }
  }
  if (!current() || state.player.current !== track) return;
  state.player.waveform.renderToken += 1;
  clearWaveformCanvas();
  loopEditSessionExpiryController.stop('global-player');
  if (!current() || state.player.current !== track) return;
  state.player.loopActive = false;
  state.player.loopStart = 0;
  state.player.loopEnd = 30;
  state.player.loopEditDurationSeconds = 0;
  const locked = isPlaybackLockedByAnotherTab();
  renderGlobalPlayerMetadata(els, locked ? getMirroredPlaybackTrack() : track);
  refreshPlayerCover(track);
  updatePlayerUi();
  if (!current() || state.player.current !== track) return;
  if (options.persist !== false) {
    persistPlayerState(true);
  }
}

function refreshPlayerCover(track) {
  const els = getPlayerElements();
  const locked = isPlaybackLockedByAnotherTab();
  if (els.coverButton) {
    const coverScope = capturePlaybackOwnershipScope();
    const coverPath = locked || !coverScope ? '' : track?.coverPath || '';
    const coverClaim = getActivePlaybackOwnershipHandle();
    state.player.coverWasOwnershipLocked = locked || !coverScope;
    const loadId = (state.player.coverLoadId || 0) + 1;
    state.player.coverLoadId = loadId;
    els.coverButton.hidden = false;
    els.coverButton.classList.toggle('is-idle-placeholder', locked || !track);
    els.coverButton.style.backgroundImage = '';
    els.coverButton.textContent = '';
    if (!track) {
      els.coverButton.textContent = '';
    } else if (coverPath && !isPlaybackLockedByAnotherTab() && isPlaybackOwnershipScopeCurrent(coverScope)
      && state.player.current === track && getActivePlaybackOwnershipHandle() === coverClaim) {
      const coverSrc = `/cover?path=${encodeURIComponent(coverPath)}`;
      const probe = new Image();
      probe.onload = () => {
        if (state.player.coverLoadId !== loadId || isPlaybackLockedByAnotherTab()
          || state.player.current !== track || !isPlaybackOwnershipScopeCurrent(coverScope)
          || getActivePlaybackOwnershipHandle() !== coverClaim) return;
        els.coverButton.classList.remove('is-idle-placeholder');
        els.coverButton.style.backgroundImage = `url("${coverSrc}")`;
        els.coverButton.hidden = false;
      };
      probe.onerror = () => {
        if (state.player.coverLoadId !== loadId || isPlaybackLockedByAnotherTab()
          || state.player.current !== track || !isPlaybackOwnershipScopeCurrent(coverScope)
          || getActivePlaybackOwnershipHandle() !== coverClaim) return;
        els.coverButton.style.backgroundImage = '';
        els.coverButton.hidden = false;
        els.coverButton.classList.remove('is-idle-placeholder');
      };
      if (state.player.coverLoadId === loadId && !isPlaybackLockedByAnotherTab()
        && isPlaybackOwnershipScopeCurrent(coverScope) && state.player.current === track
        && getActivePlaybackOwnershipHandle() === coverClaim) probe.src = coverSrc;
    } else if (!locked) {
      els.coverButton.classList.remove('is-idle-placeholder');
    }
  }
}

function beginStreamingPlayerListenSession(track, startSeconds = 0) {
  if (typeof resumeListenSessionPlayback !== 'function') return;
  const handle = getActivePlaybackOwnershipHandle();
  const attempt = captureStreamingPlaybackAttempt();
  const current = () => isPlaybackOwnershipHandleCurrent(handle) && isStreamingPlaybackAttemptCurrent(attempt)
    && state.player.current?.path === track?.path && !getPlayerPlaybackSnapshot().paused;
  if (!current()) return;
  const sessionPromise = resumeListenSessionPlayback(track, startSeconds);
  if (!sessionPromise || typeof sessionPromise.then !== 'function') return;
  void sessionPromise.then(session => current() && typeof maybeSendNowPlaying === 'function'
    ? maybeSendNowPlaying(track, session) : null).catch(error => {
      console.warn('[AlbumHaven][Playback] Listen-session start failed.', error);
    });
}

let playerTrackSelectionToken = 0;

let playerSelectionOwnership = null;
function retirePlayerSelectionOwnership(reason = 'superseded') {
  const selected = playerSelectionOwnership;
  playerSelectionOwnership = null;
  if (!selected) return;
  ++playerTrackSelectionToken;
  if (!selected.handle || !releasePlaybackOwnership('stopped', selected.handle)) cancelPlaybackAttempt(selected.attempt, reason);
}

function currentPlayerSelection(selection) {
  if (!selection || playerSelectionOwnership !== selection || selection.token !== playerTrackSelectionToken
    || selection.signal?.aborted || !isPlaybackOwnershipScopeCurrent(selection.scope)) return false;
  try { if (selection.isCurrent && selection.isCurrent() !== true) return false; } catch { return false; }
  return playerSelectionOwnership === selection && selection.token === playerTrackSelectionToken
    && !selection.signal?.aborted && isPlaybackOwnershipScopeCurrent(selection.scope)
    && (!selection.handle || isPlaybackOwnershipHandleCurrent(selection.handle));
}
function releasePausedPlayerSelection(selection) {
  if (!selection?.admitted || !selection.pauseAfterAdmission
      || !currentPlayerSelection(selection) || !getPlayerPlaybackSnapshot().paused) return false;
  const handle = selection.handle;
  selection.handle = null;
  if (handle) releasePlaybackOwnership('paused', handle);
  return currentPlayerSelection(selection);
}
function reconcilePlayerOwnership(role = streamingEngineState().roles.current) {
  const selection = playerSelectionOwnership;
  if (!currentPlayerSelection(selection) || !selection.handle || !selection.attempt
    || !isStreamingPlaybackAttemptCurrent(selection.attempt) || role !== streamingEngineState().roles.current
    || role?.track?.path !== selection.track.path) return false;
  return commitPlaybackOwnership(selection.handle, role, selection.track);
}
let topPlaybackStartEpoch = 0;
async function playTrackFromPayload(track, options = {}) {
  const topEntryEpoch = topPlaybackStartEpoch;
  const entryToken = playerTrackSelectionToken;
  const shouldAutoplay = options.autoplay !== false;
  const scope = capturePlaybackOwnershipScope();
  const allowed = () => {
    const token = playerTrackSelectionToken, selected = playerSelectionOwnership;
    try {
      const permitted = !options.signal?.aborted && (!options.isCurrent || options.isCurrent() === true)
        && isPlaybackOwnershipScopeCurrent(scope)
        && (!window.AlbumHavenCapabilities || window.AlbumHavenCapabilities.allows('library.media.read') === true);
      return permitted && token === playerTrackSelectionToken && selected === playerSelectionOwnership
        && !options.signal?.aborted && isPlaybackOwnershipScopeCurrent(scope)
        && token === playerTrackSelectionToken && selected === playerSelectionOwnership;
    } catch { return false; }
  };
  if (typeof track?.path !== 'string' || !track.path.trim() || typeof startStreamingTrack !== 'function' || !allowed() || entryToken !== playerTrackSelectionToken) return false;
  const topTrack = track.sourceKind === 'album-top'
    || typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasBinding(track);
  if (topTrack && (typeof TopPlaybackRuntime === 'undefined' || !TopPlaybackRuntime.hasBinding(track))) return false;
  if (topTrack && (streamingEngineState().pendingPromotion || streamingEngineState().pendingSeek?.kind === 'replacement')) return false;
  if (topEntryEpoch !== topPlaybackStartEpoch) return false;
  const topStartEpoch = ++topPlaybackStartEpoch;
  if (typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasQueue(state.player.playbackQueue)) TopPlaybackRuntime.cancel(state.player.playbackQueue);
  if (topStartEpoch !== topPlaybackStartEpoch || entryToken !== playerTrackSelectionToken || !allowed()) return false;
  if (typeof retirePlayerRestoreAttempt === 'function') retirePlayerRestoreAttempt('manual-selection');
  if (entryToken !== playerTrackSelectionToken || !allowed() || topStartEpoch !== topPlaybackStartEpoch) return false;
  let admittedSelection = null;
  if (topTrack) {
    const engine = streamingEngineState();
    if (engine.pendingPromotion || engine.pendingSeek?.kind === 'replacement') return false;
    if (engine.roles?.continuity && closeStreamingContinuityRole('top-manual-selection') !== true) return false;
    engine.pendingContinuityTrack = null; engine.pendingContinuityOptions = null;
    track = await TopPlaybackRuntime.prepareStart(track, {signal: options.signal, isCurrent: () =>
      topStartEpoch === topPlaybackStartEpoch && allowed()
      && (admittedSelection ? currentPlayerSelection(admittedSelection) : entryToken === playerTrackSelectionToken)});
    if (!track || topStartEpoch !== topPlaybackStartEpoch || entryToken !== playerTrackSelectionToken || !allowed()) {
      if (track) TopPlaybackRuntime.cancelStart(track);
      return false;
    }
  }
  const selection = { token: ++playerTrackSelectionToken, track, scope, handle: null, attempt: null,
    signal: options.signal, isCurrent: options.isCurrent };
  playerSelectionOwnership = selection;
  admittedSelection = selection;
  try {options.onSelectionAdmitted?.(selection.token);} catch (error) {
    if (topTrack) TopPlaybackRuntime.cancelStart(track);
    throw error;
  }
  if (topStartEpoch !== topPlaybackStartEpoch) {if (topTrack) TopPlaybackRuntime.cancelStart(track); return false;}
  if (typeof ExplicitQueueRuntime !== 'undefined') ExplicitQueueRuntime.selectionStarted();
  if (!currentPlayerSelection(selection) || !allowed()) {if (topTrack) TopPlaybackRuntime.cancelStart(track); return false;}
  if (!shouldAutoplay) releasePlaybackOwnership('stopped', getActivePlaybackOwnershipHandle());
  if (!currentPlayerSelection(selection)) {if (topTrack) TopPlaybackRuntime.cancelStart(track); return false;}
  selection.handle = shouldAutoplay ? canStartPlaybackInThisTab(track, { isCurrent: () => currentPlayerSelection(selection) && allowed() }) : null;
  if (shouldAutoplay && !selection.handle || !currentPlayerSelection(selection) || !allowed()) {
    if (selection.handle) releasePlaybackOwnership('stopped', selection.handle);
    if (topTrack) TopPlaybackRuntime.cancelStart(track);
    return false;
  }
  const resetTime = options.resetTime !== false;
  const previousPlaybackSnapshot = getPlayerPlaybackSnapshot();
  const cancelSelection = () => {
    if (topTrack) TopPlaybackRuntime.cancelStart(track);
    if (selection.handle) releasePlaybackOwnership('stopped', selection.handle);
    else cancelPlaybackAttempt(selection.attempt, 'selection-cancelled');
  };
  options.signal?.addEventListener('abort', cancelSelection, { once: true });
  try {
    if (!currentPlayerSelection(selection) || !allowed() || topStartEpoch !== topPlaybackStartEpoch) { cancelSelection(); return false; }
    const role = await startStreamingTrack(track, {
      startSeconds: resetTime ? 0 : Number(previousPlaybackSnapshot.currentTime) || 0,
      autoplay: shouldAutoplay,
      onStartAttempt(attempt) {
        selection.attempt = attempt;
        if (!currentPlayerSelection(selection)) { cancelPlaybackAttempt(attempt, 'stale-selection'); return; }
        if (selection.handle) bindPlaybackOwnershipAttempt(selection.handle, attempt);
      },
    });
    if (!currentPlayerSelection(selection) || !allowed() || topStartEpoch !== topPlaybackStartEpoch || !isStreamingPlaybackAttemptCurrent(selection.attempt)) {
      cancelSelection(); return false;
    }
    if (!role || role.track?.path !== track.path || streamingEngineState().roles.current !== role) {
      cancelSelection(); return false;
    }
    if (topTrack && (role.track !== track || !TopPlaybackRuntime.receiptCurrent(track) || !TopPlaybackRuntime.commit(track))) {
      cancelSelection(); return false;
    }
    if (typeof ExplicitQueueRuntime !== 'undefined' && options.explicitQueueTransition !== true) ExplicitQueueRuntime.replaced();
    if (!currentPlayerSelection(selection)) { cancelSelection(); return false; }
    setCurrentPlayerTrack(track, { previousPlaybackSnapshot, isCurrent: () => currentPlayerSelection(selection) });
    if (!currentPlayerSelection(selection)) { cancelSelection(); return false; }
    selection.admitted = true;
    reconcilePlayerOwnership(role);
    if (selection.pauseAfterAdmission && getPlayerPlaybackSnapshot().paused) {
      if (!releasePausedPlayerSelection(selection)) return false;
      updatePlayerUi();
      return currentPlayerSelection(selection);
    }
    if (role.firstFrameNotified) {
      void Promise.resolve(handleStreamingPlaybackFirstFrame({ generation: role.generation,
        streamId: role.streamId, trackPath: role.track.path })).catch(() => {});
    }
    if (!currentPlayerSelection(selection)) return false;
    if (shouldAutoplay) beginStreamingPlayerListenSession(track, resetTime ? 0 : previousPlaybackSnapshot.currentTime);
    if (!currentPlayerSelection(selection)) return false;
    updatePlayerUi();
    return currentPlayerSelection(selection);
  } catch (error) {
    const current = currentPlayerSelection(selection);
    cancelSelection();
    if (current) throw error;
    return false;
  } finally { options.signal?.removeEventListener('abort', cancelSelection); }
}

let handledStreamingFirstFrameIdentity = '';
let pendingStreamingFirstFrameIdentity = '';
let pendingStreamingFirstFrameSchedule = null;

async function handleStreamingPlaybackFirstFrame(event = {}) {
  const role = streamingEngineState().roles.current;
  if (!role || role.generation !== event.generation || role.streamId !== event.streamId
    || role.track?.path !== event.trackPath || role.firstFrameNotified !== true) return;
  const frameAttempt = captureStreamingPlaybackAttempt();
  const frameCurrent = () => isStreamingPlaybackAttemptCurrent(frameAttempt) && streamingEngineState().roles.current === role;
  reconcilePlayerOwnership(role);
  if (typeof reconcileRestoredPlaybackOwnership === 'function') reconcileRestoredPlaybackOwnership(role);
  if (!frameCurrent()) return;
  const selectedTrackPath = String(state.player.current?.path || '');
  const renderedTrackPath = String(event.trackPath || '');
  if (renderedTrackPath && renderedTrackPath !== selectedTrackPath) return;
  const identity = [
    Number(event.generation) || 0,
    Number(event.streamId) || 0,
    renderedTrackPath || selectedTrackPath,
  ].join(':');
  if (identity === handledStreamingFirstFrameIdentity) return;
  if (identity === pendingStreamingFirstFrameIdentity) {
    return pendingStreamingFirstFrameSchedule;
  }
  const nextTrack = typeof peekNextQueuedTrack === 'function'
    ? peekNextQueuedTrack()
    : null;
  const explicitProgression = typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.ownsProgression();
  const topProgression = typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasQueue(state.player.playbackQueue);
  if ((!nextTrack && !explicitProgression && !topProgression) || typeof scheduleStreamingContinuity !== 'function') {
    handledStreamingFirstFrameIdentity = identity;
    return;
  }
  pendingStreamingFirstFrameIdentity = identity;
  const scheduling = Promise.resolve().then(() => frameCurrent()
    ? (explicitProgression ? ExplicitQueueRuntime.prepareNext()
      : topProgression ? TopPlaybackRuntime.prepareNext() : scheduleStreamingContinuity(nextTrack)) : null);
  pendingStreamingFirstFrameSchedule = scheduling;
  try {
    await scheduling;
    if (frameCurrent()) handledStreamingFirstFrameIdentity = identity;
  } finally {
    if (pendingStreamingFirstFrameSchedule === scheduling) {
      pendingStreamingFirstFrameIdentity = '';
      pendingStreamingFirstFrameSchedule = null;
    }
  }
}

async function handleStreamingPlaybackPosition(event = {}) {
  const trackPath = String(state.player.current?.path || '');
  if (!trackPath || String(event.trackPath || '') !== trackPath) return;
  const playback = getPlayerPlaybackSnapshot();
  if (state.player.listenSession) {
    state.player.listenSession.duration_seconds = Math.round(
      (Number(playback.duration) || 0) * 1000,
    ) / 1000;
    if (typeof maybeScrobbleListenSession === 'function') {
      await maybeScrobbleListenSession(state.player.listenSession);
    }
  }
  updatePlayerUi();
}

let handledStreamingEndedIdentity = '';

async function handleStreamingPlaybackEnded(event = {}) {
  const track = state.player.current;
  const trackPath = String(track?.path || '');
  if (!trackPath || String(event.trackPath || '') !== trackPath) return;
  const role = streamingEngineState().roles.current;
  if (!role || role.generation !== event.generation || role.streamId !== event.streamId) return;
  const endedHandle = getActivePlaybackOwnershipHandle();
  const identity = [event.generation, event.streamId, trackPath].join(':');
  if (identity === handledStreamingEndedIdentity) return;
  handledStreamingEndedIdentity = identity;
  if (typeof ExplicitQueueRuntime !== 'undefined') ExplicitQueueRuntime.ended();
  const playback = getPlayerPlaybackSnapshot();
  const session = state.player.listenSession;
  if (typeof releasePlaybackOwnership === 'function') {
    releasePlaybackOwnership('paused', endedHandle);
  }
  if (typeof finalizeListenSession === 'function') {
    await finalizeListenSession('ended', {
      session,
      currentTime: Number(event.currentTime) || Number(playback.currentTime) || 0,
      duration: Number(playback.duration) || 0,
      finishedFully: true,
    });
  }
  updatePlayerUi();
}

async function handleStreamingPlaybackBoundary(event = {}) {
  const boundaryRole = streamingEngineState().roles.current;
  const boundaryHandle = getActivePlaybackOwnershipHandle();
  if (!isPlaybackOwnershipBoundaryCurrent(boundaryHandle, event) || !boundaryRole
    || boundaryRole.generation !== event.generation || boundaryRole.streamId !== event.incomingStreamId
    || boundaryRole.track?.path !== event.incomingTrackPath || boundaryRole.boundaryNotified !== true) return;
  const commitBoundary = () => {
    if (!isPlaybackOwnershipBoundaryCurrent(boundaryHandle, event) || streamingEngineState().roles.current !== boundaryRole) return false;
    const attempt = captureStreamingPlaybackAttempt();
    if (!attempt || !bindPlaybackOwnershipAttempt(boundaryHandle, attempt)) return false;
    if (playerSelectionOwnership?.handle === boundaryHandle) {
      playerSelectionOwnership.attempt = attempt; playerSelectionOwnership.track = state.player.current;
    }
    return commitPlaybackOwnership(boundaryHandle, boundaryRole, state.player.current);
  };
  const boundaryIdentity = [
    Number(event.generation) || 0,
    Number(event.outgoingStreamId) || 0,
    Number(event.incomingStreamId) || 0,
  ].join(':');
  if (state.player.lastStreamingBoundaryIdentity === boundaryIdentity) return;
  const currentPath = String(state.player.current?.path || '');
  const outgoingPath = String(event.outgoingTrackPath || '');
  if (outgoingPath && currentPath !== outgoingPath) {
    throw new Error('Streaming boundary outgoing track identity mismatch');
  }
  const queuedPreview = typeof peekNextQueuedTrack === 'function'
    ? peekNextQueuedTrack()
    : null;
  if (!isPlaybackOwnershipHandleCurrent(boundaryHandle) || streamingEngineState().roles.current !== boundaryRole) return;
  const incomingPath = String(event.incomingTrackPath || '');
  if (event.continuityKind && event.continuityKind !== 'queued-next') {
    if (outgoingPath && currentPath !== outgoingPath) {
      throw new Error('Streaming loop boundary outgoing track identity mismatch');
    }
    if (incomingPath && currentPath !== incomingPath) {
      throw new Error('Streaming loop boundary incoming track identity mismatch');
    }
    state.player.lastStreamingBoundaryIdentity = boundaryIdentity;
    if (event.continuityKind === 'whole-track-repeat' && state.player.loopActive) {
      loopEditSessionExpiryController.noteUntouchedWholeRangeWrap('global-player');
    }
    commitBoundary();
    updatePlayerUi();
    return;
  }
  if (incomingPath && queuedPreview?.path
      && String(queuedPreview.path) !== incomingPath) {
    throw new Error('Streaming boundary incoming track identity mismatch');
  }
  const promotedTrack = getNextQueuedTrack();
  if (!isPlaybackOwnershipHandleCurrent(boundaryHandle) || streamingEngineState().roles.current !== boundaryRole) return;
  if (!promotedTrack) {
    throw new Error('Streaming boundary promotion has no queued track');
  }
  if (incomingPath && String(promotedTrack.path || '') !== incomingPath) {
    throw new Error('Streaming boundary promoted track identity mismatch');
  }
  state.player.lastStreamingBoundaryIdentity = boundaryIdentity;
  const previousPlaybackSnapshot = event.outgoingPlaybackSnapshot
    || getPlayerPlaybackSnapshot();
  const outgoingSession = state.player.listenSession;
  if (outgoingSession) {
    if (state.player.listenSession === outgoingSession) {
      state.player.listenSession = null;
    }
    const finalization = finalizeListenSession('ended', {
      session: outgoingSession,
      currentTime: Number(previousPlaybackSnapshot.currentTime) || 0,
      duration: Number(previousPlaybackSnapshot.duration) || 0,
      finishedFully: true,
    });
    if (typeof observeStreamingFacadeCallback === 'function') {
      void Promise.resolve(finalization).catch(error => console.warn('[AlbumHaven][Playback] Owned operation failed.', error));
    } else if (finalization && typeof finalization.catch === 'function') {
      void finalization.catch((error) => {
        console.warn('[AlbumHaven][Playback] Boundary listen-session finalization failed.', error);
      });
    }
  }
  if (!isPlaybackOwnershipHandleCurrent(boundaryHandle) || streamingEngineState().roles.current !== boundaryRole) return;
  setCurrentPlayerTrack(promotedTrack, { previousPlaybackSnapshot, isCurrent: () => isPlaybackOwnershipHandleCurrent(boundaryHandle) && streamingEngineState().roles.current === boundaryRole });
  if (!commitBoundary()) return;
  if (event.incomingListenSession) state.player.listenSession = event.incomingListenSession;
  if (typeof resumeListenSessionPlayback === 'function') {
    const incomingSessionStart = Promise.resolve(resumeListenSessionPlayback(promotedTrack, 0)).then((incomingSession) => (
      isPlaybackOwnershipHandleCurrent(boundaryHandle) && streamingEngineState().roles.current === boundaryRole
        && typeof maybeSendNowPlaying === 'function'
        ? maybeSendNowPlaying(promotedTrack, incomingSession)
        : null
    ));
    if (typeof observeStreamingFacadeCallback === 'function') {
      void Promise.resolve(incomingSessionStart).catch(error => console.warn('[AlbumHaven][Playback] Owned operation failed.', error));
    } else {
      void incomingSessionStart.catch((error) => {
        console.warn('[AlbumHaven][Playback] Boundary listen-session start failed.', error);
      });
    }
  }
  updatePlayerUi();
  const subsequentTrack = typeof peekNextQueuedTrack === 'function'
    ? peekNextQueuedTrack()
    : null;
  if (!isPlaybackOwnershipHandleCurrent(boundaryHandle) || streamingEngineState().roles.current !== boundaryRole) return;
  if (typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.ownsProgression()) {
    await ExplicitQueueRuntime.prepareNext();
  } else if (typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasQueue(state.player.playbackQueue)) {
    await TopPlaybackRuntime.prepareNext();
  } else if (subsequentTrack && typeof scheduleStreamingContinuity === 'function') {
    await scheduleStreamingContinuity(subsequentTrack);
  }
  if (!isPlaybackOwnershipHandleCurrent(boundaryHandle) || streamingEngineState().roles.current !== boundaryRole) return;
  if (typeof promoteWaveformPeaks === 'function') {
    try {
      void Promise.resolve(promoteWaveformPeaks(
        outgoingPath || currentPath,
        String(promotedTrack.path || ''),
        Number(event.generation) || 0,
      )).catch((error) => {
        console.warn('[AlbumHaven][Waveform] Optional peak promotion failed.', error);
      });
    } catch (error) {
      console.warn('[AlbumHaven][Waveform] Optional peak promotion failed.', error);
    }
  }
}

let streamingLoopScheduleToken = 0;
let pendingPlayerPlaybackHandoff = null;

function renewPlayerLoopExpiryAfterBoundaryEdit(range) {
  const nextStart = Number(range?.startSeconds);
  const nextEnd = Number(range?.endSeconds);
  const changed = Number.isFinite(nextStart) && Number.isFinite(nextEnd)
    && (nextStart !== Number(state.player.loopStart) || nextEnd !== Number(state.player.loopEnd));
  if (changed) loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
  return changed;
}

function expirePlayerLoopCreation() {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (!state.player.loopActive) return false;
  setLoopActive(false);
  if (typeof pauseStreamingPlayback === 'function') {
    const pause = pauseStreamingPlayback();
    if (typeof observeStreamingFacadeCallback === 'function') {
      void Promise.resolve(pause).catch(error => console.warn('[AlbumHaven][Playback] Owned operation failed.', error));
    } else if (pause && typeof pause.catch === 'function') {
      void pause.catch(() => {});
    }
  }
  updatePlayerUi();
  return true;
}

function startPlayerLoopExpirySession() {
  loopEditSessionExpiryController.start({
    ownerId: 'global-player',
    onExpire: expirePlayerLoopCreation,
  });
}

function getGlobalPlayerLoopControlOptions() {
  const action = {
      enabled: Boolean(getPlayerPlaybackSnapshot().src || state.player.current?.src),
      canCreate: state.loopCreateAllowed === true,
    contextKey: state.player.current?.path || state.player.current?.src || '',
      active: state.player.loopActive,
      busy: state.player.saveBusy,
      disabledLabel: 'Start playing the track to edit the loop',
      onEnter: () => setLoopActive(true),
      onCreate: saveCurrentLoop,
      onCancel: () => setLoopActive(false),
  };
  const range = {
      getDuration: () => getPlayerDuration() || Math.max(state.player.loopEnd, 0.1),
      getRange: () => ({ startSeconds: state.player.loopStart, endSeconds: state.player.loopEnd }),
      onRangeInteractionStart: () => {
        if (isPlaybackLockedByAnotherTab()) return;
        startPlayerLoopExpirySession();
        loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
      },
      onRangePreview: (range) => {
        if (isPlaybackLockedByAnotherTab()) return;
        renewPlayerLoopExpiryAfterBoundaryEdit(range);
        state.player.loopStart = range.startSeconds;
        state.player.loopEnd = range.endSeconds;
        updateLoopInputsFromState();
        const time = getPlayerElements().time;
        if (time) time.textContent = `${formatLoopTime(state.player.loopStart, true)} - ${formatLoopTime(state.player.loopEnd, true)}`;
      },
      onRangeCommit: (range) => {
        if (isPlaybackLockedByAnotherTab()) return;
        loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
        state.player.loopStart = range.startSeconds;
        state.player.loopEnd = range.endSeconds;
        scheduleActiveStreamingLoop();
        updatePlayerUi();
      },
      onSeek: (seconds) => setPlayerPlaybackHead(seconds, { clampToLoop: false }),
      onCancel: () => setLoopActive(false),
  };
  return {
    action,
    range,
    buildActionMarkup: () => buildLoopEditActionControl({ ownerId: 'global-player' }),
    mountAction: (root) => mountLoopEditActionControl({
      root,
      enabled: action.enabled,
      canCreate: action.canCreate,
      contextKey: action.contextKey,
      active: action.active,
      busy: action.busy,
      disabledLabel: action.disabledLabel,
      onEnter: action.onEnter,
      onCreate: action.onCreate,
      onCancel: action.onCancel,
    }),
    mountRange: (root) => createLoopRangeController({ root, ...range }),
  };
}

function isNativePlayerSourceCurrent(track = state.player.current) {
  const bound = typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasBinding(track);
  return track?.sourceKind !== 'album-top' && !bound || bound && TopPlaybackRuntime.isPayloadCurrent(track);
}

function dispatchActiveStreamingLoop() {
  if (isPlaybackLockedByAnotherTab()) return false;
  const track = state.player.current;
  if (!track || !isNativePlayerSourceCurrent(track) || typeof scheduleStreamingContinuity !== 'function') return null;
  const startSeconds = Math.max(0, Number(state.player.loopStart) || 0);
  const endSeconds = Math.max(startSeconds, Number(state.player.loopEnd) || 0);
  const loopSeconds = Math.max(0, endSeconds - startSeconds);
  const durationSeconds = typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasBinding(track)
    ? getPlayerDuration() : Math.max(0, Number(track.durationSeconds) || 0);
  const wholeTrack = startSeconds === 0 && durationSeconds > 0 && endSeconds >= durationSeconds;
  const kind = wholeTrack ? 'whole-track-repeat' : (loopSeconds <= 5 ? 'short-loop' : 'long-loop');
  return scheduleStreamingContinuity(track, { kind, startSeconds, endSeconds });
}

function scheduleActiveStreamingLoop() {
  if (isPlaybackLockedByAnotherTab()) return false;
  const token = ++streamingLoopScheduleToken;
  Promise.resolve().then(() => {
    if (token !== streamingLoopScheduleToken || !state.player.loopActive) return;
    return dispatchActiveStreamingLoop();
  }).catch((error) => {
    if (typeof observeStreamingFacadeCallback === 'function') {
      console.warn('[AlbumHaven][Playback] Loop operation failed.', error);
    }
  });
}

function setLoopActive(active) {
  if (active && isPlaybackLockedByAnotherTab()) return false;
  if (active && !isNativePlayerSourceCurrent()) return false;
  if (active && state.loopCreateAllowed === false) return;
  const playback = getPlayerPlaybackSnapshot();
  if (active && (!state.player.current || !(playback.src || state.player.current?.src))) {
    showToast('Play a track before selecting a loop.', 'error', 2600);
    return;
  }
  const willActivate = Boolean(active);
  if (willActivate) {
    const duration = getPlayerDuration();
    if (!(duration > 0)) {
      showToast('Wait for the full track to finish loading before editing a loop.', 'error', 2600);
      return;
    }
    const currentTime = Math.max(0, Number(playback.currentTime) || 0);
    state.player.loopReturnTime = currentTime;
    state.player.loopWasPlaying = !playback.paused && !playback.ended;
    state.player.loopStart = 0;
    state.player.loopEnd = duration;
    state.player.loopEditDurationSeconds = duration;
    state.player.loopActive = true;
    clampLoopTimes();
    startPlayerLoopExpirySession();
    scheduleActiveStreamingLoop();
  } else {
    loopEditSessionExpiryController.stop('global-player');
    const startSeconds = Number(state.player.loopStart) || 0;
    const endSeconds = Number(state.player.loopEnd) || 0;
    if (state.player.loopActive) {
      const finalLoop = dispatchActiveStreamingLoop();
      if (typeof observeStreamingFacadeCallback === 'function') {
        void Promise.resolve(finalLoop).catch(error => console.warn('[AlbumHaven][Playback] Owned operation failed.', error));
      }
    }
    state.player.loopActive = false;
    state.player.loopEditDurationSeconds = 0;
    streamingLoopScheduleToken += 1;
    if (typeof setStreamingLoop === 'function') {
      setStreamingLoop(false, startSeconds, endSeconds);
    }
    const nextTrack = typeof peekNextQueuedTrack === 'function'
      ? peekNextQueuedTrack()
      : null;
    const explicitProgression = typeof ExplicitQueueRuntime !== 'undefined' && ExplicitQueueRuntime.ownsProgression();
    const topProgression = typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasQueue(state.player.playbackQueue);
    if ((nextTrack || explicitProgression || topProgression) && typeof scheduleStreamingContinuity === 'function') {
      const result = explicitProgression ? ExplicitQueueRuntime.prepareNext()
        : topProgression ? TopPlaybackRuntime.prepareNext() : scheduleStreamingContinuity(nextTrack, {
        kind: 'queued-next', startSeconds: 0,
      });
      if (typeof observeStreamingFacadeCallback === 'function') {
        void Promise.resolve(result).catch(error => console.warn('[AlbumHaven][Playback] Owned operation failed.', error));
      }
    }
  }
  updatePlayerUi();
}

function setLoopBoundary(which, value) {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (!isNativePlayerSourceCurrent()) return false;
  const next = Math.max(0, Number(value) || 0);
  if (which === 'start') {
    state.player.loopStart = next;
  } else {
    state.player.loopEnd = next;
  }
  clampLoopTimes();
  if (state.player.loopActive) scheduleActiveStreamingLoop();
  updatePlayerUi();
}

function setLoopPlaybackHead(value) {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (!isNativePlayerSourceCurrent()) return false;
  if (!state.player.loopActive) return;
  const next = Math.max(state.player.loopStart, Math.min(state.player.loopEnd, Number(value) || 0));
  if (typeof seekStreamingPlayback !== 'function') return;
  const seek = seekStreamingPlayback(next);
  if (typeof observeStreamingFacadeCallback === 'function') {
    void Promise.resolve(seek).catch(error => console.warn('[AlbumHaven][Playback] Owned operation failed.', error));
  } else if (seek && typeof seek.catch === 'function') {
    void seek.catch(() => {});
  }
  updatePlayerUi();
}

function setPlayerPlaybackHead(value, options = {}) {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (!isNativePlayerSourceCurrent()) return false;
  const next = Math.max(0, Number(value) || 0);
  const playback = getPlayerPlaybackSnapshot();
  const shouldResumeSegment = !playback.paused;
  const track = state.player.current;
  const claim = getActivePlaybackOwnershipHandle();
  closeListenSegment();
  if (isPlaybackLockedByAnotherTab() || state.player.current !== track || getActivePlaybackOwnershipHandle() !== claim
    || !isNativePlayerSourceCurrent(track)) return;
  if (state.player.loopActive && options.clampToLoop !== false) {
    setLoopPlaybackHead(next);
    if (shouldResumeSegment) void resumeListenSessionPlayback(state.player.current, next);
    return;
  }
  if (typeof seekStreamingPlayback !== 'function') return;
  const seek = seekStreamingPlayback(next);
  if (typeof observeStreamingFacadeCallback === 'function') {
    void Promise.resolve(seek).catch(error => console.warn('[AlbumHaven][Playback] Owned operation failed.', error));
  } else if (seek && typeof seek.catch === 'function') {
    void seek.catch(() => {});
  }
  if (shouldResumeSegment) void resumeListenSessionPlayback(state.player.current, next);
  updatePlayerUi();
}

function isTextEntryElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const tagName = String(element.tagName || '').toUpperCase();
  if (tagName === 'TEXTAREA') return true;
  if (element.isContentEditable) return true;
  if (tagName !== 'INPUT') return false;
  const type = String(element.getAttribute('type') || element.type || '').toLowerCase();
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'radio', 'range', 'reset', 'submit'].includes(type);
}

function focusPlayerTimeline() {
  const els = getPlayerElements();
  const timeline = els.timeline;
  const playback = getPlayerPlaybackSnapshot();
  if (!(timeline instanceof HTMLElement) || timeline.disabled || !(playback.src || state.player.current?.src)) return;
  timeline.focus({ preventScroll: true });
}

function handlePlayerTimelineKeydown(event) {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const playback = getPlayerPlaybackSnapshot();
  if (!(playback.src || state.player.current?.src)) return;
  const direction = event.key === 'ArrowLeft' ? -1 : 1;
  const stepSeconds = event.shiftKey ? 5 : 1;
  event.preventDefault();
  event.stopPropagation?.();
  setPlayerPlaybackHead((Number(playback.currentTime) || 0) + (direction * stepSeconds));
}

function handlePlayerKeyboardSeek(event) {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (isTextEntryElement(target)) return;
  const insidePlayer = target?.closest?.('.global-player');
  if (!insidePlayer) return;
  handlePlayerTimelineKeydown(event);
  focusPlayerTimeline();
}

function isPlayerSurfaceVisible() {
  const player = getPlayerElements().player;
  if (!(player instanceof HTMLElement) || player.hidden) return false;
  const style = getComputedStyle(player);
  const bounds = player.getBoundingClientRect();
  const opacity = Number.parseFloat(style.opacity);
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.visibility !== 'collapse'
    && (!Number.isFinite(opacity) || opacity > 0)
    && bounds.width > 0
    && bounds.height > 0;
}

function togglePlayerPlayback(options = {}) {
  const entrySelection = playerTrackSelectionToken;
  if (isPlaybackLockedByAnotherTab()) return false;
  const playback = getPlayerPlaybackSnapshot();
  const track = state.player.current;
  if (!(playback.src || track?.src)) return false;
  if (!playback.paused) { pausePlayerPlaybackForHandoff(playback); return true; }
  if (!isNativePlayerSourceCurrent(track)) return false;
  if (playback.ended) {
    void playTrackFromPayload(track, { resetTime: true, isCurrent: () => state.player.current === track }).catch(error => {
      console.warn('[AlbumHaven][Playback] Restart failed.', error);
    });
    return true;
  }
  const scope = capturePlaybackOwnershipScope();
  let role = streamingEngineState().roles.current;
  const attempt = captureStreamingPlaybackAttempt();
  if (!role || !attempt || !isPlaybackOwnershipScopeCurrent(scope)
    || window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.media.read')
    || entrySelection !== playerTrackSelectionToken) return false;
  const handle = canStartPlaybackInThisTab(track, { isCurrent: () => state.player.current === track
    && streamingEngineState().roles.current === role && isStreamingPlaybackAttemptCurrent(attempt)
    && isNativePlayerSourceCurrent(track) });
  if (!handle || !bindPlaybackOwnershipAttempt(handle, attempt)) return false;
  const current = () => state.player.current === track && streamingEngineState().roles.current === role
    && isStreamingPlaybackAttemptCurrent(attempt) && isPlaybackOwnershipHandleCurrent(handle)
    && isNativePlayerSourceCurrent(track);
  if (!current()) { releasePlaybackOwnership('stopped', handle); return false; }
  playerSelectionOwnership = { token: ++playerTrackSelectionToken, track, scope, handle, attempt };
  const resume = async () => {
    const resumed = await resumeStreamingPlayback(null, null, role, attempt);
    if (resumed !== true || !current()) { releasePlaybackOwnership('stopped', handle); return false; }
    commitPlaybackOwnership(handle, role, track);
    if (!current()) return false;
    beginStreamingPlayerListenSession(track, playback.ended ? 0 : Number(playback.currentTime) || 0);
    if (!current()) return false;
    updatePlayerUi();
    if (current() && options.focusTimelineOnResume !== false) focusPlayerTimeline();
    return true;
  };
  void resume().catch(() => releasePlaybackOwnership('stopped', handle));
  return true;
}

function pausePlayerPlaybackForHandoff(playback = getPlayerPlaybackSnapshot()) {
  if (isPlaybackLockedByAnotherTab()) return Promise.resolve(false);
  const handle = getActivePlaybackOwnershipHandle();
  const retiredHandoff = typeof captureStreamingRetiredOutgoingAttempt === 'function'
    ? captureStreamingRetiredOutgoingAttempt() : null;
  const attempt = captureStreamingPlaybackAttempt() || retiredHandoff;
  if (pendingPlayerPlaybackHandoff) return pendingPlayerPlaybackHandoff;
  const pauseIncoming = retiredHandoff && playerSelectionOwnership?.attempt === retiredHandoff
    && currentPlayerSelection(playerSelectionOwnership);
  const pausedSelection = pauseIncoming ? playerSelectionOwnership : null;
  if (pauseIncoming) {
    // Keep the admitted incoming selection until its role is presented paused;
    // releasing its pending claim here would cancel that same selection.
    pausedSelection.pauseAfterAdmission = true;
  }
  if ((playback.paused && !pauseIncoming) || typeof pauseStreamingPlayback !== 'function') return Promise.resolve(false);
  const pauseEffects = Promise.resolve(pauseStreamingPlayback()).then(() => {
    if (pauseIncoming) {
      if (pausedSelection.admitted && releasePausedPlayerSelection(pausedSelection)) updatePlayerUi();
      return isStreamingPlaybackAttemptCurrent(attempt);
    }
    if (getActivePlaybackOwnershipHandle() !== handle || !isStreamingPlaybackAttemptCurrent(attempt)) return false;
    closeListenSegment();
    markListenSessionPaused(Number(playback.currentTime) || 0);
    if (typeof maybeScrobbleListenSession === 'function') {
      void maybeScrobbleListenSession(state.player.listenSession);
    }
    if (typeof releasePlaybackOwnership === 'function') {
      releasePlaybackOwnership('paused', handle);
    }
    updatePlayerUi();
    return true;
  });
  const trackedPause = pauseEffects.finally(() => {
    if (pendingPlayerPlaybackHandoff === trackedPause) pendingPlayerPlaybackHandoff = null;
  });
  pendingPlayerPlaybackHandoff = trackedPause;
  if (typeof observeStreamingFacadeCallback === 'function') {
    void trackedPause.catch(error => console.warn('[AlbumHaven][Playback] Pause failed.', error));
  } else {
    void trackedPause.catch(() => {});
  }
  return trackedPause;
}

function isPlayerNativeKeyboardAction(target) {
  if (!target || target.getAttribute?.('data-loop-range-handle')) return false;
  const tag = String(target.tagName || '').toUpperCase();
  const type = String(target.getAttribute?.('type') || target.type || '').toLowerCase();
  const role = String(target.getAttribute?.('role') || '').toLowerCase();
  return ['BUTTON', 'A', 'SELECT'].includes(tag)
    || (tag === 'INPUT' && type !== 'range')
    || ['button', 'menuitem', 'checkbox', 'radio', 'switch', 'tab'].includes(role)
    || Boolean(target.closest?.('button:not([data-loop-range-handle]), a, select, [role="button"], [role="menuitem"]'));
}
function handlePlayerKeyboardPlayback(event) {
  if (
    !event
    || event.defaultPrevented
    || event.isComposing
    || event.repeat
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return false;
  if (event.key !== ' ' && event.key !== 'Spacebar' && event.code !== 'Space') return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (isTextEntryElement(target) || isPlayerNativeKeyboardAction(target)) return false;
  if (
    typeof handleUtilityLoopSpacePlayback === 'function'
    && handleUtilityLoopSpacePlayback(event)
  ) {
    event.preventDefault();
    event.stopPropagation?.();
    return true;
  }
  const playback = getPlayerPlaybackSnapshot();
  if (!(playback.src || state.player.current?.src)) return false;
  if (!isPlayerSurfaceVisible()) return false;
  if (!togglePlayerPlayback({ focusTimelineOnResume: false })) return false;
  event.preventDefault();
  event.stopPropagation?.();
  return true;
}

async function saveCurrentLoop() {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (state.loopCreateAllowed === false) return;
  if (state.player.saveBusy) return;
  const current = state.player.current;
  if (!current || !state.player.loopActive) return;
  state.player.saveBusy = true;
  try {
    const name = String(await showLoopNameDialog() || '').trim();
    if (!name || isPlaybackLockedByAnotherTab() || state.player.current !== current) return;
    const response = await fetch('/loops/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        source_path: current.path,
        start_seconds: state.player.loopStart,
        end_seconds: state.player.loopEnd,
        artist: current.artist || '',
        title: current.title || '',
        album: current.album || '',
        cover_path: current.coverPath || '',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to save loop');
    }
    state.utility.loopMutationGeneration = Number(state.utility.loopMutationGeneration || 0) + 1;
    state.utility.loops = Array.isArray(data.loops) ? data.loops : [data.loop, ...(state.utility.loops || [])].filter(Boolean);
    state.utility.loopsLoaded = true;
    state.utility.selectedLoopId = String(data.loop?.id || state.utility.selectedLoopId || '');
    state.utility.selectedLoopGroupKey = data.loop ? buildUtilityLoopGroupKey(data.loop) : state.utility.selectedLoopGroupKey;
    state.utility.selectedLoopDetailMode = 'group';
    setLoopActive(false);
    showToast('Loop saved.', 'success', 2600);
    if (state.utility.activeTab === 'loops') renderUtilityModalContent();
  } catch (error) {
    console.error('[AlbumHaven][Loops] Failed to save loop.', error);
    showToast(error.message || 'Failed to save loop.', 'error', 4200);
  } finally {
    state.player.saveBusy = false;
    updatePlayerUi();
  }
}

function handlePlayerLoopEditKeydown(event) {
  if (isPlaybackLockedByAnotherTab()) return false;
  if (!event || !state.player.loopActive) return false;
  if (event.key === 'Escape') {
    setLoopActive(false);
    return true;
  }
  if (
    event.key !== 'Enter'
    || event.defaultPrevented
    || event.isComposing
    || event.repeat
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (isTextEntryElement(target) || isPlayerNativeKeyboardAction(target) || target?.closest?.('[role="dialog"], dialog, [aria-modal="true"]')) {
    return false;
  }
  event.preventDefault();
  event.stopPropagation?.();
  void saveCurrentLoop();
  return true;
}

function attachSharedPlayer() {
  document.querySelectorAll('.play-track-button').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', event => activateSharedTrackButton(btn, { focusTimeline: event?.isTrusted !== false }));
  });
}

function activateSharedTrackButton(btn, { restart = false, focusTimeline = false } = {}) {
  if (btn?.disabled) return;
  if (typeof canPlayTrackModalSelection === 'function' && !canPlayTrackModalSelection(btn)) return;
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.media.read')) return;
  const src = btn.getAttribute('data-src');
  if (!src) return;
  if (typeof triggerAlbumTrackPlayActivation === 'function' && btn.classList?.contains('album-track-table__play')) {
    triggerAlbumTrackPlayActivation(btn);
  }
  const trackPath = btn.getAttribute('data-track-path') || decodeURIComponent((src.split('path=')[1] || '').split('&')[0] || '');
  const isCurrentTrack = String(state.player.current?.path || '') === String(trackPath || '');
  const playback = getPlayerPlaybackSnapshot();
  const isLoadedCurrentTrack = isCurrentTrack && String(playback.src || '') === String(src);
  if (isLoadedCurrentTrack && !restart) {
    togglePlayerPlayback({ focusTimelineOnResume: focusTimeline });
    updatePlayerUi();
    return;
  }
  const selectedAlbum = typeof getTrackModalSelectionAlbumFor === 'function' ? getTrackModalSelectionAlbumFor(btn) : null;
  // Detached native-action buttons do not belong to an unrelated open album.
  // Preserve the actual bound modal selection first; fallback is modal-owned.
  const trackModal = document.getElementById('track-modal');
  const currentAlbum = selectedAlbum || (trackModal && !trackModal.hidden && trackModal.contains(btn)
    ? state.modalReleases[state.modalReleaseIndex] || null
    : null);
  const listeningIntent = currentAlbum && typeof createAlbumListeningIntent === 'function' ? createAlbumListeningIntent(currentAlbum) : null;
  const selectedTrack = {
    src,
    path: trackPath, inventory_track_ref: btn.getAttribute('data-inventory-track-ref') || null,
    title: btn.getAttribute('data-track-title') || 'Track',
    artist: btn.getAttribute('data-track-artist') || '',
    albumArtist: btn.getAttribute('data-track-album-artist') || '',
    album: btn.getAttribute('data-track-album') || '',
    coverPath: btn.getAttribute('data-track-cover') || '',
    durationSeconds: Number(btn.getAttribute('data-track-duration-seconds')) || 0,
  };
  if (listeningIntent && typeof bindAlbumListeningIntent === 'function') bindAlbumListeningIntent(selectedTrack, listeningIntent);
  const playbackStart = playTrackFromPayload(selectedTrack);
  if (currentAlbum) setAlbumPlaybackQueue(currentAlbum, trackPath, listeningIntent || undefined);
  else state.player.playbackQueue = null;
  if (typeof observeStreamingFacadeCallback === 'function') {
    void Promise.resolve(playbackStart).catch(error => console.warn('[AlbumHaven][Playback] Selection failed.', error));
  } else {
    void playbackStart.catch((error) => {
      console.warn('[AlbumHaven][Playback] Track selection failed.', error);
    });
  }
  if (focusTimeline) focusPlayerTimeline();
}

function claimGlobalPlayerSpaceOwnership() {
  if (typeof clearUtilityLoopSpaceOwner === 'function') {
    clearUtilityLoopSpaceOwner();
  }
}

function attachPlayerEvents() {
  const els = getPlayerElements();

  if (typeof mountGlobalPlayerLoopControls === 'function') mountGlobalPlayerLoopControls();

  let thinSeekGesture = null;
  let ordinarySeekGesture = null;
  let suppressThinSeekClick = false;
  const discardSeek = () => {
    if (thinSeekGesture?.claimed) { try { els.player.releasePointerCapture?.(thinSeekGesture.pointerId); } catch {} }
    thinSeekGesture = null; ordinarySeekGesture = null; state.player.timelineDragging = false; state.player.timelineDragPreviewSeconds = null;
  };
  els.player?.addEventListener('pointerdown', (event) => {
    if (isPlaybackLockedByAnotherTab()) { discardSeek(); return; }
    if (thinSeekGesture || event.isPrimary === false || (event.button != null && event.button !== 0)) return;
    suppressThinSeekClick = false;
    if (Number(window.innerWidth) > 900 || els.player.getAttribute('data-player-seekbar-presentation') !== 'thin'
      || !state.player.current || state.player.loopActive || state.player.timelineDragging) return;
    if (event.target === els.timeline || els.timeline?.parentElement?.contains?.(event.target)) return;
    const control = event.target?.closest?.('button, a, input, select, textarea');
    if (control && control !== els.play) return;
    const rect = els.timeline?.getBoundingClientRect();
    const duration = getPlayerDuration();
    if (!rect || !(rect.width > 0) || !(duration > 0)) return;
    const headX = rect.left + (Number(els.timeline.value) || 0) / duration * rect.width;
    if (Math.abs(event.clientX - headX) > 28) return;
    if (control !== els.play && (event.clientY < rect.top - 12 || event.clientY > rect.top + rect.height + 12)) return;
    thinSeekGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, track: getTrackIdentity(state.player.current), claim: getActivePlaybackOwnershipHandle(), scope: capturePlaybackOwnershipScope(), claimed: false };
  }, { capture: true });
  els.player?.addEventListener('click', (event) => {
    if (!suppressThinSeekClick || event.detail === 0) return;
    suppressThinSeekClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
  els.player?.addEventListener('pointerdown', claimGlobalPlayerSpaceOwnership);
  els.player?.addEventListener('focusin', claimGlobalPlayerSpaceOwnership);
  els.play?.addEventListener('click', () => togglePlayerPlayback());
  els.albumLink?.addEventListener('click', () => {
    if (isPlaybackLockedByAnotherTab()) return;
    const selected = state.player.current;
    const album = resolveAlbumForPlayerTrack(selected);
    if (album && selected === state.player.current && !isPlaybackLockedByAnotherTab()) openTrackModal(album);
  });
  els.coverButton?.addEventListener('click', () => {
    if (isPlaybackLockedByAnotherTab()) return;
    const selected = state.player.current;
    const album = resolveAlbumForPlayerTrack(selected);
    if (album && selected === state.player.current && !isPlaybackLockedByAnotherTab()) openTrackModal(album, { coverLightboxGallery: false, foreground: true });
  });
  els.timeline?.addEventListener('keydown', handlePlayerTimelineKeydown);
  els.timeline?.addEventListener('input', () => {
    if (isPlaybackLockedByAnotherTab()) { discardSeek(); return; }
    const next = Number(els.timeline.value) || 0;
    if (state.player.timelineDragging) return;
    setPlayerPlaybackHead(next);
  });
  els.timeline?.parentElement?.addEventListener('pointerdown', (event) => {
    if (isPlaybackLockedByAnotherTab()) { discardSeek(); return; }
    if (thinSeekGesture || state.player.loopActive || event.target?.closest('.player-loop-handle')) return;
    if (!state.player.current) return;
    const next = getTimelineSecondsFromClientX(event.clientX);
    event.preventDefault();
    ordinarySeekGesture = { track: state.player.current, claim: getActivePlaybackOwnershipHandle(), scope: capturePlaybackOwnershipScope() };
    state.player.timelineDragging = true;
    state.player.timelineDragPreviewSeconds = next;
    if (els.timeline) els.timeline.value = String(next);
    updatePlayerUi();
  });
  document.addEventListener('pointermove', (event) => {
    if (isPlaybackLockedByAnotherTab()) { discardSeek(); return; }
    if (ordinarySeekGesture && (state.player.current !== ordinarySeekGesture.track
      || getActivePlaybackOwnershipHandle() !== ordinarySeekGesture.claim
      || !isPlaybackOwnershipScopeCurrent(ordinarySeekGesture.scope))) { discardSeek(); return; }
    if (thinSeekGesture) {
      if (event.pointerId !== thinSeekGesture.pointerId) return;
      if (getTrackIdentity(state.player.current) !== thinSeekGesture.track || getActivePlaybackOwnershipHandle() !== thinSeekGesture.claim
        || !isPlaybackOwnershipScopeCurrent(thinSeekGesture.scope) || state.player.loopActive) {
        if (thinSeekGesture.claimed) {
          state.player.timelineDragging = false;
          state.player.timelineDragPreviewSeconds = null;
          updatePlayerUi();
        }
        thinSeekGesture = null;
        return;
      }
      if (!thinSeekGesture.claimed) {
        const dx = Math.abs(event.clientX - thinSeekGesture.x);
        const dy = Math.abs(event.clientY - thinSeekGesture.y);
        if (dy > 8 && dy >= dx) { thinSeekGesture = null; return; }
        if (dx < 8 || dx <= dy * 1.25) return;
        thinSeekGesture.claimed = true;
        state.player.timelineDragging = true;
        suppressThinSeekClick = true;
        els.player.setPointerCapture?.(event.pointerId);
      }
      event.preventDefault();
    }
    if (!state.player.timelineDragging) return;
    const next = getTimelineSecondsFromClientX(event.clientX);
    state.player.timelineDragPreviewSeconds = next;
    if (els.timeline) els.timeline.value = String(next);
    updatePlayerUi();
  });
  document.addEventListener('pointerup', (event) => {
    if (isPlaybackLockedByAnotherTab()) { discardSeek(); return; }
    if (ordinarySeekGesture && (state.player.current !== ordinarySeekGesture.track
      || getActivePlaybackOwnershipHandle() !== ordinarySeekGesture.claim
      || !isPlaybackOwnershipScopeCurrent(ordinarySeekGesture.scope))) { discardSeek(); return; }
    if (thinSeekGesture) {
      if (event.pointerId !== thinSeekGesture.pointerId) return;
      const gesture = thinSeekGesture;
      if (gesture.claimed) { try { els.player.releasePointerCapture?.(gesture.pointerId); } catch {} }
      thinSeekGesture = null;
      if (!gesture.claimed) return;
      if (getTrackIdentity(state.player.current) !== gesture.track || getActivePlaybackOwnershipHandle() !== gesture.claim
        || !isPlaybackOwnershipScopeCurrent(gesture.scope) || state.player.loopActive) {
        state.player.timelineDragging = false;
        state.player.timelineDragPreviewSeconds = null;
        updatePlayerUi();
        return;
      }
    }
    if (state.player.timelineDragging) {
      const next = Number(state.player.timelineDragPreviewSeconds);
      if (Number.isFinite(next)) setPlayerPlaybackHead(next);
    }
    ordinarySeekGesture = null;
    state.player.timelineDragging = false;
    state.player.timelineDragPreviewSeconds = null;
  });
  document.addEventListener('pointercancel', (event) => {
    if (thinSeekGesture && event.pointerId !== thinSeekGesture.pointerId) return;
    discardSeek();
    suppressThinSeekClick = false;
    if (!state.player.timelineDragging) return;
    state.player.timelineDragging = false;
    state.player.timelineDragPreviewSeconds = null;
    updatePlayerUi();
  });
  document.addEventListener('keydown', handlePlayerKeyboardSeek);
  document.addEventListener('keydown', handlePlayerKeyboardPlayback, { capture: true });
  els.loopStartInput?.addEventListener('change', () => {
    const value = parseLoopTime(els.loopStartInput.value);
    if (Number.isFinite(value)) setLoopBoundary('start', value);
    else updateLoopInputsFromState();
  });
  els.loopEndInput?.addEventListener('change', () => {
    const value = parseLoopTime(els.loopEndInput.value);
    if (Number.isFinite(value)) setLoopBoundary('end', value);
    else updateLoopInputsFromState();
  });
  document.addEventListener('keydown', handlePlayerLoopEditKeydown);
  window.addEventListener('resize', () => {
    updateWaveformAppearance();
  });
  if (!state.player.current) {
    setCurrentPlayerTrack(null, { persist: false });
  }
  updatePlayerUi();
  restorePlayerState();
}

function syncLoopCreateCapability() {
  const canCreate = state.loopCreateAllowed === true;
  if (typeof window !== 'undefined') window.AlbumHavenAppearance?.instance?.setLoopCreateAllowed?.(canCreate);
  if (state.utility) {
    state.utility.allowedActions = { ...(state.utility.allowedActions || {}), 'library.loops.create': canCreate };
  }
  document.querySelectorAll?.('[data-loop-action-owner]').forEach(root => {
    root._loopActionController?.update({ canCreate });
  });
}

function disposeMountedLoopActions(container) {
  container?.querySelectorAll?.('[data-loop-range-owner]').forEach(root => {
    root._loopRangeController?.destroy?.();
    delete root._loopRangeController;
  });
  container?.querySelectorAll?.('[data-loop-action-owner]').forEach(root => {
    const owner = root.getAttribute?.('data-loop-action-owner') || '';
    if (owner.startsWith('saved-loop-')) {
      const id = owner.slice('saved-loop-'.length);
      state.utility.savedLoopOpenEpoch ||= {};
      state.utility.savedLoopOpenEpoch[id] = (Number(state.utility.savedLoopOpenEpoch[id]) || 0) + 1;
    }
    root._loopActionController?.destroy();
    delete root._loopActionController;
    if (root.dataset) delete root.dataset.loopActionsBound;
  });
}
