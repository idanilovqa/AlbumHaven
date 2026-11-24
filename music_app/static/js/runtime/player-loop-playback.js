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
    if (state.player.current) state.player.current.durationSeconds = playbackDuration;
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

// The player shows the song that sounds: pressing another song while one plays keeps the player's
// title, time, cover and waveform until the pressed song sounds, then they change together. The
// pressed row shows the press at once; rows read the selection, not this.
function playerTrackKey(track) {
  return String(track?.path || track?.src || '');
}

// The snapshot is the playing engine's: in the Android app the web engine's mode never moves.
function currentTrackAwaitsSound(playback, track) {
  if ((playback.mode ?? state.player.streaming?.mode) === 'starting') return true;
  return Boolean(playback.src && track.src && playback.src !== track.src);
}

// The current song once it sounds. Until then the song shown before it, at the time it last showed,
// or running on while it still sounds (a switch that hands over at a boundary).
function resolveShownPlayerTrack(playback) {
  const current = state.player.current || null;
  const shown = state.player.shown || null;
  const track = shown && current && playerTrackKey(shown.track) !== playerTrackKey(current)
    && currentTrackAwaitsSound(playback, current) ? shown.track : current;
  if (!track) {
    state.player.shown = null;
    return null;
  }
  const sounds = !playback.src || !track.src || playback.src === track.src;
  const live = sounds && track === current;
  if (sounds) {
    state.player.shown = {
      track,
      live,
      currentTime: Number(playback.currentTime) || 0,
      duration: Number(playback.duration) || Number(track.durationSeconds) || 0,
    };
  } else if (shown && playerTrackKey(shown.track) === playerTrackKey(track)) {
    state.player.shown = { ...shown, track, live: false };
  } else {
    state.player.shown = { track, live: false, currentTime: 0, duration: Number(track.durationSeconds) || 0 };
  }
  return state.player.shown;
}

function resolvePlayerUiStatus(playback) {
  const lockedByAnotherTab = typeof isPlaybackLockedByAnotherTab === 'function' && isPlaybackLockedByAnotherTab();
  const playbackUnavailable = lockedByAnotherTab && typeof getPlaybackOwnershipState === 'function'
    && getPlaybackOwnershipState().blockedReason === 'playback_unavailable';
  const mirroredTrack = lockedByAnotherTab && typeof getMirroredPlaybackTrack === 'function'
    ? getMirroredPlaybackTrack()
    : null;
  const shownTrack = resolveShownPlayerTrack(playback)?.track || null;
  const displayTrack = mirroredTrack || shownTrack;
  const playingElsewhere = lockedByAnotherTab && !playbackUnavailable;
  return {
    lockedByAnotherTab,
    playbackUnavailable,
    // The overlay dims the other device's song under its status, whether or not it can be taken over.
    playingElsewhere,
    // Only where it can be taken over is Play pressable above the overlay.
    canPlayHere: playingElsewhere && (typeof canTakePlaybackOverHere !== 'function' || canTakePlaybackOverHere()),
    blockedLabel: playbackUnavailable ? 'Playback unavailable' : 'Playing in another tab',
    displayTrack,
    shownTrack,
    hasTrack: Boolean(displayTrack && (lockedByAnotherTab || playback.src || state.player.current?.src)),
  };
}

// The seek position and its time label: all that a timeline drag preview changes.
function renderPlayerTimelinePosition(els, playback, { hasTrack, lockedByAnotherTab, playingElsewhere, blockedLabel }) {
  // A song shown while another starts keeps its own time and length with its title: never the started
  // song's clock under it.
  const shown = resolveShownPlayerTrack(playback);
  const held = !lockedByAnotherTab && shown && !shown.live ? shown : null;
  const duration = held ? held.duration : getPlayerDuration();
  const dragPreview = Number(state.player.timelineDragPreviewSeconds);
  const current = held ? held.currentTime : state.player.timelineDragging && Number.isFinite(dragPreview)
    ? dragPreview
    : Number(playback.currentTime) || 0;
  if (els.timeline) {
    els.timeline.max = String(Math.max(duration, 0.1));
    els.timeline.value = String(Math.min(current, duration || current));
    els.timeline.style?.setProperty('--player-seek-progress', `${duration > 0 ? Math.max(0, Math.min(100, current / duration * 100)) : 0}%`);
    els.timeline.disabled = !hasTrack || lockedByAnotherTab;
  }
  if (els.time) {
    els.time.hidden = !hasTrack || playingElsewhere;
    els.time.textContent = lockedByAnotherTab
      ? blockedLabel
      : state.player.loopActive
      ? `${formatLoopTime(state.player.loopStart, true)} - ${formatLoopTime(state.player.loopEnd, true)}`
      : `${formatLoopTime(current)} / ${formatLoopTime(duration)}`;
  }
  return { duration, current };
}

function updatePlayerUi() {
  const els = getPlayerElements();
  const playback = getPlayerPlaybackSnapshot();
  const status = resolvePlayerUiStatus(playback);
  const { lockedByAnotherTab, playbackUnavailable, playingElsewhere, canPlayHere, blockedLabel, displayTrack, shownTrack, hasTrack } = status;
  els.player?.classList?.toggle('is-playing-elsewhere', playingElsewhere);
  if (els.elsewhere) els.elsewhere.hidden = !playingElsewhere;
  state.player.lastKnownWasPlaying = Boolean(!lockedByAnotherTab && !playback.paused && !playback.ended);
  els.player?.classList?.toggle('is-empty', !hasTrack);
  const emptyMessage = els.player?.querySelector?.('[data-player-empty-message]');
  if (emptyMessage) emptyMessage.hidden = hasTrack;
  const { duration, current } = renderPlayerTimelinePosition(els, playback, status);
  els.loopActions?._loopActionController?.update({
    enabled: Boolean(!lockedByAnotherTab && (getPlayerPlaybackSnapshot().src || state.player.current?.src)),
    canCreate: state.loopCreateAllowed === true,
    contextKey: state.player.current?.path || state.player.current?.src || '',
    active: state.player.loopActive,
    busy: state.player.saveBusy,
  });
  if (els.play) {
    renderGlobalPlayerPlayGlyph(els.play, playback.paused);
    els.play.setAttribute('aria-label', canPlayHere ? 'Play here'
      : lockedByAnotherTab ? (playbackUnavailable ? blockedLabel : 'Playback locked in another tab')
      : (playback.paused ? 'Play' : 'Pause'));
    els.play.title = canPlayHere ? 'Play in this tab instead' : '';
    els.play.disabled = (lockedByAnotherTab && !canPlayHere) || !hasTrack;
  }
  if (typeof syncCompactPlayerUi === 'function') syncCompactPlayerUi({ displayTrack, playback, hasTrack, lockedByAnotherTab });
  els.timeline?.parentElement?.classList.toggle('is-looping', state.player.loopActive);
  if (els.timeline?.parentElement) {
    els.timeline.parentElement.classList.toggle('is-idle', !hasTrack);
    els.timeline.parentElement.setAttribute('data-idle-label', lockedByAnotherTab ? blockedLabel : 'Nothing is playing');
  }
  if (els.loopRegion) els.loopRegion.hidden = !state.player.loopActive;
  if (els.loopStartHandle) els.loopStartHandle.hidden = !state.player.loopActive;
  if (els.loopEndHandle) els.loopEndHandle.hidden = !state.player.loopActive;
  const loopRangeSurface = els.loopRange?.querySelector('[data-loop-range-surface]');
  if (loopRangeSurface) loopRangeSurface.hidden = !state.player.loopActive;
  renderGlobalPlayerMetadata(els, displayTrack);
  renderGlobalPlayerCover(els, shownTrack);
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
}

function setCurrentPlayerTrack(track, options = {}) {
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
  if (track && !String(track.coverRef || '').trim() && typeof resolveAlbumForPlayerTrack === 'function') {
    const resolvedCoverRef = String(resolveAlbumForPlayerTrack(track)?.cover_ref || '').trim();
    if (resolvedCoverRef) track = { ...track, coverRef: resolvedCoverRef };
  }
  state.player.current = track;
  state.player.timelineDragging = false;
  state.player.timelineDragPreviewSeconds = null;
  if (typeof loadPlayingWaveformPeaks === 'function') {
    const playingWaveform = loadPlayingWaveformPeaks(String(track?.path || ''));
    if (playingWaveform && typeof playingWaveform.catch === 'function') {
      void playingWaveform.catch(() => {});
    }
  }
  state.player.waveform.renderToken += 1;
  if (!track) {
    state.player.waveform.shown = null;
    clearWaveformCanvas();
  }
  loopEditSessionExpiryController.stop('global-player');
  state.player.loopActive = false;
  state.player.loopStart = 0;
  state.player.loopEnd = 30;
  state.player.loopEditDurationSeconds = 0;
  // The player draws what it shows: the new song only once it sounds.
  updatePlayerUi();
  if (options.persist !== false) {
    persistPlayerState(true);
  }
}

// Loads a cover only when the shown song or its artwork changes: redraws while it plays reuse it.
function renderGlobalPlayerCover(els, track) {
  if (!els.coverButton) return;
  const coverRef = track?.coverRef || '';
  const coverKey = track ? `${playerTrackKey(track)}\n${coverRef}` : '';
  if (state.player.coverKey === coverKey) return;
  state.player.coverKey = coverKey;
  const loadId = (state.player.coverLoadId || 0) + 1;
  state.player.coverLoadId = loadId;
  els.coverButton.hidden = false;
  els.coverButton.classList.toggle('is-idle-placeholder', !track);
  els.coverButton.style.backgroundImage = '';
  els.coverButton.textContent = '';
  if (track && coverRef) {
    const coverSrc = `/cover/${encodeURIComponent(coverRef)}`;
    const probe = new Image();
    probe.onload = () => {
      if (state.player.coverLoadId !== loadId) return;
      els.coverButton.classList.remove('is-idle-placeholder');
      els.coverButton.style.backgroundImage = `url("${coverSrc}")`;
      els.coverButton.hidden = false;
    };
    probe.onerror = () => {
      if (state.player.coverLoadId !== loadId) return;
      els.coverButton.style.backgroundImage = '';
      els.coverButton.hidden = false;
      els.coverButton.classList.remove('is-idle-placeholder');
    };
    probe.src = coverSrc;
  } else if (track) {
    els.coverButton.classList.remove('is-idle-placeholder');
  }
}

function beginStreamingPlayerListenSession(track, startSeconds = 0) {
  if (typeof resumeListenSessionPlayback !== 'function') return;
  const sessionPromise = resumeListenSessionPlayback(track, startSeconds);
  if (!sessionPromise || typeof sessionPromise.then !== 'function') return;
  void sessionPromise.then((session) => {
    // A start or resume may send a backed-off now-playing or scrobble at once.
    if (typeof retryListenWritesNow === 'function') retryListenWritesNow(session);
    return typeof maybeSendNowPlaying === 'function' ? maybeSendNowPlaying(track, session) : null;
  });
}

let playerTrackSelectionToken = 0;
// As long as the app's bridge waits for an answer: a start with no sound by then has timed out.
const PLAYER_START_TIMEOUT_MS = 15000;
let pendingPlayerStart = null;

// From the press until the song sounds, its start fails or times out, or a later action replaces it.
function isPlayerStartPending(path) {
  const start = pendingPlayerStart;
  if (!start || start.path !== path || start.selectionToken !== playerTrackSelectionToken
      || performance.now() - start.pressedAtMs >= PLAYER_START_TIMEOUT_MS) return false;
  if (!start.settled) return true;
  const playback = getPlayerPlaybackSnapshot();
  return !playback.paused && !playback.ended && ['starting', 'buffering'].includes(playback.mode);
}

// A switch takes a moment to reach the listener; the click should not. The rows show the press at
// once; the player stays on the sounding song.
function renderSelectedTrackState() {
  if (typeof refreshTrackModalPlaybackState === 'function') refreshTrackModalPlaybackState();
  if (typeof refreshNonAlbumModalPlaybackState === 'function') refreshNonAlbumModalPlaybackState();
}

function showSelectedTrackImmediately(track, shouldAutoplay, startSeconds) {
  if (!shouldAutoplay) return;
  state.player.selectedStartSeconds = startSeconds;
  state.player.selectedTrack = track;
  renderSelectedTrackState();
}

function clearSelectedTrack() {
  if (!state.player.selectedTrack) return;
  state.player.selectedTrack = null;
  if (typeof resumeRestingTrackWaveform === 'function') {
    // Once the switch has settled: a song that started is the current one by then.
    void Promise.resolve().then(resumeRestingTrackWaveform);
  }
  renderSelectedTrackState();
}

// Settles once the next frame has painted; at once where no frame comes (a hidden tab).
function afterNextPlayerPaint() {
  if (typeof requestAnimationFrame !== 'function' || typeof document === 'undefined' || document.hidden) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(() => {
      clearTimeout(fallback);
      resolve();
    }, 0));
  });
}

// A handover stops this tab: a press still waiting for its stream never starts it afterwards.
function cancelPendingPlayerSelection() {
  playerTrackSelectionToken += 1;
  clearSelectedTrack();
}

function mayStartBeforeTheAnswer() {
  return typeof loadsSilentlyWhileAsking !== 'function' || loadsSilentlyWhileAsking()
    || (typeof holdsPlaybackClaim === 'function' && holdsPlaybackClaim());
}

async function playTrackFromPayload(track, options = {}) {
  const selectionToken = ++playerTrackSelectionToken;
  const shouldAutoplay = options.autoplay !== false;
  if (shouldAutoplay && typeof noteStreamingPress === 'function') noteStreamingPress(track);
  const requestedTrackPath = String(track?.path || '');
  const previousTrack = state.player.current || null;
  const currentTrackPath = String(previousTrack?.path || '');
  // Replaced by this press: the current song, and one pressed before it that has yet to sound.
  const replacesSong = [currentTrackPath, String(state.player.selectedTrack?.path || '')]
    .some((replaced) => replaced && replaced !== requestedTrackPath);
  if (shouldAutoplay && requestedTrackPath && replacesSong
      && typeof cancelStreamingWaveformGeneration === 'function') {
    cancelStreamingWaveformGeneration(
      Number(getPlayerPlaybackSnapshot().generation ?? state.player.streaming?.generation) || 0,
    );
  }
  const ownershipAlreadyClaimed = options.ownershipClaimed === true
    && typeof isActivePlaybackOwner === 'function' && isActivePlaybackOwner();
  // A press paints and loads at once, also where the first press lets the browser start audio, and is
  // heard only once granted: the audio thread holds it, as nothing starts without an answer (the
  // shortened wait). It waits before loading where nothing can hold the sound (the app's
  // own player, unless it already owns playback), and where another client is known to play: then it
  // paints nothing either and the overlay offers Play here.
  const knownElsewhere = shouldAutoplay && !ownershipAlreadyClaimed && options.takeover !== true
    && typeof isPlaybackLockedByAnotherTab === 'function' && isPlaybackLockedByAnotherTab();
  const pendingClaim = shouldAutoplay && !ownershipAlreadyClaimed && typeof canStartPlaybackInThisTab === 'function'
    ? canStartPlaybackInThisTab(track, { takeover: options.takeover === true })
    : true;
  // A press that goes no further also ends the switch it superseded.
  const refused = () => {
    if (selectionToken === playerTrackSelectionToken) clearSelectedTrack();
    return false;
  };
  if (pendingClaim === false) return refused();
  const asksBeforeLoading = pendingClaim !== true && (knownElsewhere || !mayStartBeforeTheAnswer());
  if (asksBeforeLoading) {
    if (!knownElsewhere && options.takeover !== true && track?.path) {
      showSelectedTrackImmediately(track, shouldAutoplay, Math.max(0, Number(options.startSeconds) || 0));
    }
    const granted = await pendingClaim;
    if (selectionToken !== playerTrackSelectionToken) return false;
    if (!granted) return refused();
  }
  if (shouldAutoplay && typeof startSelectedTrackWaveformPeaks === 'function') {
    // The waveform builds while the stream opens, not after it.
    startSelectedTrackWaveformPeaks(requestedTrackPath);
  }
  if (selectionToken !== playerTrackSelectionToken) return false;
  pendingPlayerPlaybackHandoff = null;
  if (!track?.path) return refused();
  const resetTime = options.resetTime !== false;
  const previousPlaybackSnapshot = getPlayerPlaybackSnapshot();
  const requestedStartSeconds = Number(options.startSeconds);
  const startSeconds = Number.isFinite(requestedStartSeconds)
    ? Math.max(0, requestedStartSeconds)
    : (resetTime ? 0 : Number(previousPlaybackSnapshot.currentTime) || 0);
  if (typeof startStreamingTrack !== 'function') {
    throw new Error('Streaming playback engine is unavailable');
  }
  showSelectedTrackImmediately(track, shouldAutoplay, startSeconds);
  const pendingStart = shouldAutoplay
    ? { path: requestedTrackPath, selectionToken, pressedAtMs: performance.now(), settled: false }
    : null;
  pendingPlayerStart = pendingStart;
  // The pressed song paints before its stream starts: the start's own work never holds the frame
  // that shows the press, which is instant even at 100% CPU. Audio that is not yet running (the first
  // press after load) starts in the press itself, where every browser lets the press start sound.
  if (shouldAutoplay && state.player.streaming?.context?.state === 'running') await afterNextPlayerPaint();
  if (selectionToken !== playerTrackSelectionToken) return false;
  // Loading while it waits for the server, a stream may die with the network that keeps the answer away.
  const waitsForGrant = pendingClaim !== true && !asksBeforeLoading
    && !(typeof holdsPlaybackClaim === 'function' && holdsPlaybackClaim());
  const start = () => startStreamingTrack(track, {
    startSeconds,
    autoplay: shouldAutoplay,
    allowSuspendedAutoplayFallback: options.allowSuspendedAutoplayFallback === true,
    takeover: options.takeover === true,
  });
  let startedRole;
  let diedWaiting = false;
  try {
    startedRole = await start();
  } catch (error) {
    if (selectionToken !== playerTrackSelectionToken) return false;
    if (!waitsForGrant) {
      pendingPlayerStart = null;
      clearSelectedTrack();
      throw error;
    }
    diedWaiting = true;
  }
  if (selectionToken !== playerTrackSelectionToken) return false;
  const startedTrackPath = String(startedRole?.track?.path || '');
  if (!diedWaiting && (startedRole === null || (startedTrackPath && startedTrackPath !== String(track.path)))) {
    pendingPlayerStart = null;
    clearSelectedTrack();
    throw new Error(startedRole === null
      ? 'Streaming playback did not start'
      : 'Streaming playback started an unexpected track identity');
  }
  if (pendingStart) pendingStart.settled = true;
  // The pressed song becomes the current one before the pending choice clears, so the player never
  // shows the song it replaced in between.
  setCurrentPlayerTrack(track, { previousPlaybackSnapshot });
  clearSelectedTrack();
  if (pendingClaim !== true && !await pendingClaim) {
    if (selectionToken === playerTrackSelectionToken) {
      pauseStreamingPlayback();
      updatePlayerUi();
    }
    return false;
  }
  if (selectionToken !== playerTrackSelectionToken) return false;
  if (waitsForGrant && (diedWaiting || getPlayerPlaybackSnapshot().mode === 'error')) {
    // Answered, it starts by itself, with no second press.
    let retryError = null;
    try {
      startedRole = await start();
    } catch (error) {
      retryError = error;
    }
    if (selectionToken !== playerTrackSelectionToken) return false;
    if (retryError || startedRole === null) {
      // As any failed start: the song it replaced stays the player's, with its waveform.
      pendingPlayerStart = null;
      setCurrentPlayerTrack(previousTrack, { previousPlaybackSnapshot });
      if (previousTrack?.path && typeof loadPlayingWaveformPeaks === 'function') {
        void loadPlayingWaveformPeaks(previousTrack.path).catch(() => {});
      }
      updatePlayerUi();
      throw retryError || new Error('Streaming playback did not start');
    }
  }
  if (startedRole?.firstFrameNotified) {
    const reconciliation = handleStreamingPlaybackFirstFrame({
      generation: startedRole.generation,
      streamId: startedRole.streamId,
      trackPath: String(startedRole.track?.path || track.path),
    });
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(reconciliation, 'first-frame-reconciliation-error');
    } else {
      void reconciliation.catch((error) => {
        console.warn('[AlbumHaven][Playback] First-frame reconciliation failed.', error);
      });
    }
  }
  if (shouldAutoplay) {
    beginStreamingPlayerListenSession(track, startSeconds);
  }
  updatePlayerUi();
  return true;
}

function resumePlayerPlaybackFromPageCache(playbackSnapshot) {
  const track = state.player.current;
  if (!track || typeof isActivePlaybackOwner !== 'function' || !isActivePlaybackOwner()) {
    return Promise.resolve(false);
  }
  return playTrackFromPayload(track, {
    autoplay: true,
    ownershipClaimed: true,
    startSeconds: Number(playbackSnapshot?.currentTime) || 0,
  });
}

// Only the queue owner knows whether `track` follows the current one inside the same album.
function queuedNextContinuityOptions(track) {
  return {
    kind: 'queued-next',
    startSeconds: 0,
    consecutiveAlbumBoundary: typeof isConsecutiveAlbumSuccessor === 'function'
      && isConsecutiveAlbumSuccessor(track),
  };
}

// A first-frame schedule that has not settled by then stops holding its identity, so a later
// first frame or reconciliation of the same stream schedules its continuity again.
const STREAMING_FIRST_FRAME_SCHEDULE_DEADLINE_MS = 2000;
let handledStreamingFirstFrameIdentity = '';
let pendingStreamingFirstFrameIdentity = '';
let pendingStreamingFirstFrameSchedule = null;

async function handleStreamingPlaybackFirstFrame(event = {}) {
  const selectedTrackPath = String(state.player.current?.path || '');
  const renderedTrackPath = String(event.trackPath || '');
  if (renderedTrackPath && renderedTrackPath !== selectedTrackPath) return;
  if (pendingPlayerStart?.path === selectedTrackPath) pendingPlayerStart = null;
  if (typeof endTrackWaveformRestOnSound === 'function') endTrackWaveformRestOnSound(selectedTrackPath);
  const identity = [
    Number(event.generation) || 0,
    Number(event.streamId) || 0,
    renderedTrackPath || selectedTrackPath,
  ].join(':');
  if (identity === handledStreamingFirstFrameIdentity) return;
  if (identity === pendingStreamingFirstFrameIdentity) {
    return pendingStreamingFirstFrameSchedule;
  }
  // It sounds: the player's title, time, cover and waveform change to it together, now.
  if (typeof getPlayerElements === 'function') updatePlayerUi();
  if (typeof publishPlaybackPositionSoon === 'function') publishPlaybackPositionSoon();
  const selectionToken = playerTrackSelectionToken;
  const nextTrack = typeof peekNextQueuedTrack === 'function'
    ? peekNextQueuedTrack()
    : null;
  if ((!nextTrack && !state.player.loopActive) || typeof scheduleStreamingContinuity !== 'function') {
    handledStreamingFirstFrameIdentity = identity;
    return;
  }
  pendingStreamingFirstFrameIdentity = identity;
  const scheduling = Promise.resolve().then(() => {
    if (selectionToken !== playerTrackSelectionToken
      || selectedTrackPath !== String(state.player.current?.path || '')) return;
    return state.player.loopActive
      ? dispatchActiveStreamingLoop()
      : nextTrack ? scheduleStreamingContinuity(nextTrack, queuedNextContinuityOptions(nextTrack)) : null;
  });
  pendingStreamingFirstFrameSchedule = scheduling;
  let deadline = 0;
  const expired = new Promise((resolve) => {
    deadline = setTimeout(resolve, STREAMING_FIRST_FRAME_SCHEDULE_DEADLINE_MS, false);
  });
  try {
    if (await Promise.race([scheduling.then(() => true), expired])) {
      handledStreamingFirstFrameIdentity = identity;
    }
  } finally {
    clearTimeout(deadline);
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
    if (typeof maybeRetryNowPlaying === 'function') void maybeRetryNowPlaying(state.player.listenSession);
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
  const identity = [event.generation, event.streamId, trackPath].join(':');
  if (identity === handledStreamingEndedIdentity) return;
  handledStreamingEndedIdentity = identity;
  const playback = getPlayerPlaybackSnapshot();
  const session = state.player.listenSession;
  const ownershipVersion = typeof getPlaybackOwnershipState === 'function'
    ? (getPlaybackOwnershipState().requestVersion || 0) : null;
  if (typeof finalizeListenSession === 'function') {
    await finalizeListenSession('ended', {
      session,
      currentTime: Number(event.currentTime) || Number(playback.currentTime) || 0,
      duration: Number(playback.duration) || 0,
      finishedFully: true,
    });
  }
  const isStillThisEnd = () => ownershipVersion === null
    || ownershipVersion === (getPlaybackOwnershipState().requestVersion || 0);
  // The engine names a queued successor it could not continue into: a new sample rate, or a
  // native queue that ended its window. It starts on the claim still held, with no wait for a new one.
  const continues = Boolean(event.startNextTrackPath)
    && String(peekNextQueuedTrack()?.path || '') === event.startNextTrackPath;
  if (!continues && typeof releasePlaybackOwnership === 'function' && isStillThisEnd()) {
    // Released is what lets another client sound: the last rendered audio leaves the output first.
    if (typeof drainStreamingOutput === 'function') await drainStreamingOutput();
    if (isStillThisEnd()) await releasePlaybackOwnership('stopped', track);
  }
  updatePlayerUi();
  if (continues) {
    // A locked phone may refuse the new context; stay paused so a tap can resume it. A successor that
    // does not start leaves the claim to the heartbeat, which gives a silent tab's back.
    await playTrackFromPayload(getNextQueuedTrack(), { allowSuspendedAutoplayFallback: true });
  }
}

async function handleStreamingPlaybackBoundary(event = {}) {
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
    updatePlayerUi();
    return;
  }
  if (incomingPath && queuedPreview?.path
      && String(queuedPreview.path) !== incomingPath) {
    throw new Error('Streaming boundary incoming track identity mismatch');
  }
  const promotedTrack = getNextQueuedTrack();
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
      observeStreamingFacadeCallback(finalization, 'listen-session-boundary-finalization-error');
    } else if (finalization && typeof finalization.catch === 'function') {
      void finalization.catch((error) => {
        console.warn('[AlbumHaven][Playback] Boundary listen-session finalization failed.', error);
      });
    }
  }
  setCurrentPlayerTrack(promotedTrack, { previousPlaybackSnapshot });
  if (typeof publishPlaybackPositionSoon === 'function') publishPlaybackPositionSoon();
  // A gapless move sounds at the boundary itself.
  if (typeof endTrackWaveformRestOnSound === 'function') endTrackWaveformRestOnSound(promotedTrack.path);
  if (event.incomingListenSession) state.player.listenSession = event.incomingListenSession;
  if (typeof resumeListenSessionPlayback === 'function') {
    const incomingSessionStart = Promise.resolve(resumeListenSessionPlayback(promotedTrack, 0)).then((incomingSession) => (
      typeof maybeSendNowPlaying === 'function'
        ? maybeSendNowPlaying(promotedTrack, incomingSession)
        : null
    ));
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(incomingSessionStart, 'listen-session-boundary-start-error');
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
  if (subsequentTrack && typeof scheduleStreamingContinuity === 'function') {
    await scheduleStreamingContinuity(subsequentTrack, queuedNextContinuityOptions(subsequentTrack));
  }
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
let pendingPlayerPlaybackHandoffSelectionToken = null;

function renewPlayerLoopExpiryAfterBoundaryEdit(range) {
  const nextStart = Number(range?.startSeconds);
  const nextEnd = Number(range?.endSeconds);
  const changed = Number.isFinite(nextStart) && Number.isFinite(nextEnd)
    && (nextStart !== Number(state.player.loopStart) || nextEnd !== Number(state.player.loopEnd));
  if (changed) loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
  return changed;
}

function expirePlayerLoopCreation() {
  if (!state.player.loopActive) return false;
  setLoopActive(false);
  if (typeof pauseStreamingPlayback === 'function') {
    const pause = pauseStreamingPlayback();
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(pause, 'loop-edit-expiry-pause-error');
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
        startPlayerLoopExpirySession();
        loopEditSessionExpiryController.renewAfterBoundaryEdit('global-player');
      },
      onRangePreview: (range) => {
        renewPlayerLoopExpiryAfterBoundaryEdit(range);
        state.player.loopStart = range.startSeconds;
        state.player.loopEnd = range.endSeconds;
        updateLoopInputsFromState();
        const time = getPlayerElements().time;
        if (time) time.textContent = `${formatLoopTime(state.player.loopStart, true)} - ${formatLoopTime(state.player.loopEnd, true)}`;
      },
      onRangeCommit: (range) => {
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

function dispatchActiveStreamingLoop() {
  const track = state.player.current;
  if (!track || typeof scheduleStreamingContinuity !== 'function') return null;
  const startSeconds = Math.max(0, Number(state.player.loopStart) || 0);
  const endSeconds = Math.max(startSeconds, Number(state.player.loopEnd) || 0);
  const loopSeconds = Math.max(0, endSeconds - startSeconds);
  const durationSeconds = Math.max(0, Number(track.durationSeconds) || 0);
  const wholeTrack = startSeconds === 0 && durationSeconds > 0 && endSeconds >= durationSeconds;
  const kind = wholeTrack ? 'whole-track-repeat' : (loopSeconds <= 5 ? 'short-loop' : 'long-loop');
  return scheduleStreamingContinuity(track, { kind, startSeconds, endSeconds });
}

function scheduleActiveStreamingLoop() {
  const token = ++streamingLoopScheduleToken;
  Promise.resolve().then(() => {
    if (token !== streamingLoopScheduleToken || !state.player.loopActive) return;
    return dispatchActiveStreamingLoop();
  }).catch((error) => {
    if (typeof observeStreamingFacadeCallback === 'function') {
      observeStreamingFacadeCallback(Promise.reject(error), 'loop-control-error');
    }
  });
}

function setLoopActive(active) {
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
        observeStreamingFacadeCallback(finalLoop, 'loop-control-error');
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
    if (nextTrack && typeof scheduleStreamingContinuity === 'function') {
      const result = scheduleStreamingContinuity(nextTrack, queuedNextContinuityOptions(nextTrack));
      if (typeof observeStreamingFacadeCallback === 'function') {
        observeStreamingFacadeCallback(result, 'loop-disable-continuity-error');
      }
    }
  }
  updatePlayerUi();
}

function setLoopBoundary(which, value) {
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
  if (!state.player.loopActive) return;
  const next = Math.max(state.player.loopStart, Math.min(state.player.loopEnd, Number(value) || 0));
  if (typeof seekStreamingPlayback !== 'function') return;
  const seek = seekStreamingPlayback(next);
  if (typeof observeStreamingFacadeCallback === 'function') {
    observeStreamingFacadeCallback(seek, 'seek-control-error');
  } else if (seek && typeof seek.catch === 'function') {
    void seek.catch(() => {});
  }
  if (typeof publishPlaybackPositionSoon === 'function') publishPlaybackPositionSoon();
  updatePlayerUi();
}

function setPlayerPlaybackHead(value, options = {}) {
  const next = Math.max(0, Number(value) || 0);
  const playback = getPlayerPlaybackSnapshot();
  const shouldResumeSegment = !playback.paused;
  closeListenSegment();
  if (state.player.loopActive && options.clampToLoop !== false) {
    setLoopPlaybackHead(next);
    if (shouldResumeSegment) void resumeListenSessionPlayback(state.player.current, next);
    return;
  }
  if (typeof seekStreamingPlayback !== 'function') return;
  const seek = seekStreamingPlayback(next);
  if (typeof observeStreamingFacadeCallback === 'function') {
    observeStreamingFacadeCallback(seek, 'seek-control-error');
  } else if (seek && typeof seek.catch === 'function') {
    void seek.catch(() => {});
  }
  if (shouldResumeSegment) void resumeListenSessionPlayback(state.player.current, next);
  if (typeof publishPlaybackPositionSoon === 'function') publishPlaybackPositionSoon();
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
  const focusTimelineOnResume = options.focusTimelineOnResume !== false;
  // Play while another client plays moves its song here (playback.claim.takeover).
  if (typeof isPlaybackPlayingElsewhere === 'function' && isPlaybackPlayingElsewhere()) {
    void Promise.resolve(takeOverPlaybackHere()).catch((error) => {
      console.warn('[AlbumHaven][Playback] Taking playback over failed.', error);
    });
    return true;
  }
  const playback = getPlayerPlaybackSnapshot();
  if (!(playback.src || state.player.current?.src)) return false;
  if (typeof resumeStreamingPlayback !== 'function'
      || typeof pauseStreamingPlayback !== 'function') return false;
  if (playback.paused) {
    const track = state.player.current;
    const selectionToken = ++playerTrackSelectionToken;
    clearSelectedTrack();
    Promise.resolve().then(async () => {
      if (selectionToken !== playerTrackSelectionToken) return false;
      const claim = typeof canStartPlaybackInThisTab === 'function' ? canStartPlaybackInThisTab(track) : true;
      // The audio starts inside the press and is held until the grant; a refusal pauses it again.
      const early = claim !== true && mayStartBeforeTheAnswer()
        && playback.mode !== 'stopped' && !playback.ended
        ? resumeStreamingPlayback()
        : null;
      // The controls follow the sound as soon as it resumes, not after the claim's round trip.
      Promise.resolve(early).then((resumed) => {
        if (resumed && selectionToken === playerTrackSelectionToken) updatePlayerUi();
      }).catch(() => {});
      if (claim !== true && !await claim) {
        if (early && selectionToken === playerTrackSelectionToken) {
          pauseStreamingPlayback();
          updatePlayerUi();
        }
        return false;
      }
      if (track !== state.player.current || selectionToken !== playerTrackSelectionToken) return false;
      pendingPlayerPlaybackHandoff = null;
      if (early) {
        const held = getPlayerPlaybackSnapshot();
        if (held.mode !== 'error') return early;
        // The stream died while it waited for the server: answered, it starts by itself at its place.
        return Boolean(await startStreamingTrack(track, { startSeconds: Number(held.currentTime) || 0 }));
      }
      if (playback.mode === 'stopped') {
        return Boolean(await startStreamingTrack(track, {
          startSeconds: playback.ended ? 0 : (Number(playback.currentTime) || 0),
        }));
      }
      if (playback.ended && typeof seekStreamingPlayback === 'function') await seekStreamingPlayback(0);
      if (selectionToken !== playerTrackSelectionToken) return false;
      // Resumed on the claim its pause kept: only once its first frame sounds does it tell the server it
      // plays again, so other devices see it within a round trip and the request never delays the sound.
      const sayItPlays = claim === true && typeof publishPlaybackPositionSoon === 'function'
        ? () => { publishPlaybackPositionSoon(); }
        : null;
      return resumeStreamingPlayback(null, null, null, sayItPlays);
    }).then((resumed) => {
      if (resumed === false || selectionToken !== playerTrackSelectionToken) return;
      beginStreamingPlayerListenSession(
        state.player.current,
        playback.ended ? 0 : (Number(playback.currentTime) || 0),
      );
      updatePlayerUi();
      if (focusTimelineOnResume) focusPlayerTimeline();
    }).catch(() => {});
  } else {
    pausePlayerPlaybackForHandoff(playback);
  }
  return true;
}

function pausePlayerPlaybackForHandoff(playback = getPlayerPlaybackSnapshot()) {
  if (pendingPlayerPlaybackHandoff && pendingPlayerPlaybackHandoffSelectionToken === playerTrackSelectionToken) {
    return pendingPlayerPlaybackHandoff;
  }
  if (playback.paused || typeof pauseStreamingPlayback !== 'function') return Promise.resolve(false);
  pendingPlayerPlaybackHandoffSelectionToken = ++playerTrackSelectionToken;
  const selectionToken = playerTrackSelectionToken;
  // The switch it supersedes never finishes: nothing may go on naming its song.
  clearSelectedTrack();
  const track = state.player.current;
  const session = state.player.listenSession;
  const ownership = typeof getPlaybackOwnershipState === 'function' ? getPlaybackOwnershipState() : null;
  const ownershipVersion = ownership ? (ownership.requestVersion = (ownership.requestVersion || 0) + 1) : null;
  const isCurrentPause = () => selectionToken === playerTrackSelectionToken
    && session === state.player.listenSession && track === state.player.current
    && (ownershipVersion === null || ownershipVersion === (getPlaybackOwnershipState().requestVersion || 0));
  // The claim stays a while instead of being given back, so Play sounds at once even before this pause's
  // listen writes finish. Another device's press meanwhile asks this tab, which yields once it is silent.
  if (typeof holdPlaybackClaimThroughPause === 'function') holdPlaybackClaimThroughPause();
  const pauseEffects = Promise.resolve(pauseStreamingPlayback()).then(async () => {
    if (!isCurrentPause()) return false;
    // The button shows Play at once; what follows may wait on a network that is gone.
    updatePlayerUi();
    closeListenSegment();
    markListenSessionPaused(Number(playback.currentTime) || 0);
    if (typeof maybeScrobbleListenSession === 'function') {
      await maybeScrobbleListenSession(session);
    }
    if (!isCurrentPause()) return false;
    let saved = true;
    if (typeof persistPausedListenSession === 'function') {
      try {
        await persistPausedListenSession(session);
      } catch (error) {
        if (!isCurrentPause()) return false;
        saved = false;
        // Offline the listen stays open and the next checkpoint saves it; only an answer is a failure.
        if (error?.status) showToast('Listening history could not be saved.', 'error', 4200);
      }
    }
    if (!isCurrentPause()) return saved;
    updatePlayerUi();
    return saved;
  });
  const trackedPause = pauseEffects.finally(() => {
    if (pendingPlayerPlaybackHandoff === trackedPause) pendingPlayerPlaybackHandoff = null;
  });
  pendingPlayerPlaybackHandoff = trackedPause;
  if (typeof observeStreamingFacadeCallback === 'function') {
    observeStreamingFacadeCallback(trackedPause, 'pause-control-error');
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
  if (state.loopCreateAllowed === false) return;
  if (state.player.saveBusy) return;
  const current = state.player.current;
  if (!current || !state.player.loopActive) return;
  state.player.saveBusy = true;
  try {
    const name = String(await showLoopNameDialog() || '').trim();
    if (!name) return;
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
        cover_ref: current.coverRef || '',
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
    const trackRow = btn.closest?.('.album-track-table__row');
    if (trackRow && trackRow.dataset.doubleClickBound !== '1') {
      trackRow.dataset.doubleClickBound = '1';
      trackRow.addEventListener('dblclick', handleAlbumTrackRowDoubleClick);
      trackRow.addEventListener('click', handleAlbumTrackRowClick);
    }
    btn.addEventListener('click', event => activateSharedTrackButton(btn, { focusTimeline: event?.isTrusted !== false }));
  });
}

function activateSharedTrackButton(btn, { restart = false, focusTimeline = false } = {}) {
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.media.read')) return;
  const src = btn.getAttribute('data-src');
  if (!src) return;
  if (typeof triggerAlbumTrackPlayActivation === 'function' && btn.classList?.contains('album-track-table__play')) {
    triggerAlbumTrackPlayActivation(btn);
  }
  const trackPath = btn.getAttribute('data-track-path') || decodeURIComponent((src.split('path=')[1] || '').split('&')[0] || '');
  if (isPlayerStartPending(trackPath)) {
    // A press on a song still starting is ignored. Its one start keeps the wait it began with, double
    // tap or not.
    if (typeof countIgnoredStreamingPress === 'function') countIgnoredStreamingPress(trackPath);
    if (typeof retryStreamingConnection === 'function') retryStreamingConnection();
    return;
  }
  const isCurrentTrack = String(state.player.current?.path || '') === String(trackPath || '');
  const playback = getPlayerPlaybackSnapshot();
  const isLoadedCurrentTrack = isCurrentTrack && String(playback.src || '') === String(src);
  if (isLoadedCurrentTrack && !restart) {
    togglePlayerPlayback({ focusTimelineOnResume: focusTimeline });
    updatePlayerUi();
    return;
  }
  const currentAlbum = !document.getElementById('track-modal')?.hidden
    ? state.modalReleases[state.modalReleaseIndex] || null
    : null;
  const playbackStart = playTrackFromPayload({
    src,
    path: trackPath,
    title: btn.getAttribute('data-track-title') || 'Track',
    artist: btn.getAttribute('data-track-artist') || '',
    albumArtist: btn.getAttribute('data-track-album-artist') || '',
    album: btn.getAttribute('data-track-album') || '',
    coverRef: btn.getAttribute('data-track-cover') || '',
    durationSeconds: Number(btn.getAttribute('data-track-duration-seconds')) || 0,
  });
  if (currentAlbum) {
    setAlbumPlaybackQueue(currentAlbum, trackPath);
  } else {
    state.player.playbackQueue = null;
  }
  if (typeof observeStreamingFacadeCallback === 'function') {
    observeStreamingFacadeCallback(playbackStart, 'track-selection-start-error');
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
  let suppressThinSeekClick = false;
  els.player?.addEventListener('pointerdown', (event) => {
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
    thinSeekGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, track: getTrackIdentity(state.player.current), claimed: false };
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
    void openPlayerTrackAlbum(state.player.current);
  });
  // On a phone the artist and title rows are most of the player, so a tap there opens the album too.
  els.title?.closest('.player-track-meta')?.addEventListener('click', (event) => {
    if (event.target?.closest?.('#player-album-link') || !state.player.current) return;
    if (typeof usesMobilePageLayout !== 'function' || !usesMobilePageLayout()) return;
    void openPlayerTrackAlbum(state.player.current);
  });
  els.coverButton?.addEventListener('click', () => {
    void openPlayerTrackAlbum(state.player.current, { coverLightboxGallery: false, foreground: true });
  });
  els.timeline?.addEventListener('keydown', handlePlayerTimelineKeydown);
  els.timeline?.addEventListener('input', () => {
    const next = Number(els.timeline.value) || 0;
    if (state.player.timelineDragging) return;
    setPlayerPlaybackHead(next);
  });
  els.timeline?.parentElement?.addEventListener('pointerdown', (event) => {
    if (thinSeekGesture || state.player.loopActive || event.target?.closest('.player-loop-handle')) return;
    if (!state.player.current) return;
    const next = getTimelineSecondsFromClientX(event.clientX);
    event.preventDefault();
    state.player.timelineDragging = true;
    state.player.timelineDragPreviewSeconds = next;
    if (els.timeline) els.timeline.value = String(next);
    updatePlayerUi();
  });
  document.addEventListener('pointermove', (event) => {
    if (thinSeekGesture) {
      if (event.pointerId !== thinSeekGesture.pointerId) return;
      if (getTrackIdentity(state.player.current) !== thinSeekGesture.track || state.player.loopActive) {
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
    const playback = getPlayerPlaybackSnapshot();
    renderPlayerTimelinePosition(getPlayerElements(), playback, resolvePlayerUiStatus(playback));
  });
  document.addEventListener('pointerup', (event) => {
    if (thinSeekGesture) {
      if (event.pointerId !== thinSeekGesture.pointerId) return;
      const gesture = thinSeekGesture;
      thinSeekGesture = null;
      if (!gesture.claimed) return;
      if (getTrackIdentity(state.player.current) !== gesture.track || state.player.loopActive) {
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
    state.player.timelineDragging = false;
    state.player.timelineDragPreviewSeconds = null;
  });
  document.addEventListener('pointercancel', (event) => {
    if (thinSeekGesture && event.pointerId !== thinSeekGesture.pointerId) return;
    thinSeekGesture = null;
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
