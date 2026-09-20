const utilityLoopStereoLoads = new WeakMap();
const utilityLoopStereoQueue = [];
let utilityLoopStereoLoadActive = false;

function drainUtilityLoopStereoQueue() {
  const eligible = job => job.canvas.isConnected
    && state.player.appearance?.seekbarMode === 'waveform'
    && !state.utility.loopEditors?.[job.loopId]?.active
    && document.querySelector(`[data-loop-stereo-waveform="${cssEscape(job.loopId)}"]`) === job.canvas;
  for (let index = utilityLoopStereoQueue.length - 1; index >= 0; index -= 1) {
    const job = utilityLoopStereoQueue[index];
    if (eligible(job)) continue;
    job.canvas.hidden = true;
    job.canvas.parentElement?.classList.toggle('is-stereo-waveform', false);
    utilityLoopStereoQueue.splice(index, 1);
    utilityLoopStereoLoads.delete(job.canvas);
  }
  if (utilityLoopStereoLoadActive || !utilityLoopStereoQueue.length) return;
  const job = utilityLoopStereoQueue.shift();
  utilityLoopStereoLoadActive = true;
  Promise.resolve(loadSavedLoopWaveformPeaks(job.loopId)).catch(() => null).then(peaks => {
    job.entry.loading = false;
    job.entry.peaks = peaks;
    job.entry.retryAt = Date.now() + 5000;
    if (eligible(job)) {
      updateUtilityLoopStereoWaveform(job.loopId, job.audio);
    } else {
      job.canvas.hidden = true;
      job.canvas.parentElement?.classList.toggle('is-stereo-waveform', false);
    }
  }).finally(() => {
    utilityLoopStereoLoadActive = false;
    drainUtilityLoopStereoQueue();
  });
}

function updateUtilityLoopStereoWaveform(loopId, audio) {
  const canvas = document.querySelector(`[data-loop-stereo-waveform="${cssEscape(loopId)}"]`);
  if (!canvas || !audio) return;
  const enabled = state.player.appearance?.seekbarMode === 'waveform';
  const editing = Boolean(state.utility.loopEditors?.[loopId]?.active);
  const cached = utilityLoopStereoLoads.get(canvas);
  const coolingDown = cached && !cached.loading && !cached.peaks && Date.now() < cached.retryAt;
  const presented = enabled && !editing && !coolingDown;
  canvas.hidden = !presented;
  canvas.parentElement?.classList.toggle('is-stereo-waveform', presented);
  if (!enabled || editing) { drainUtilityLoopStereoQueue(); return; }
  if (cached?.peaks) {
    const duration = Number(audio.duration) || 0;
    drawCombinedLoopWaveform(canvas, cached.peaks, duration > 0 ? (Number(audio.currentTime) || 0) / duration : 0);
    return;
  }
  if (cached && (cached.loading || Date.now() < cached.retryAt)) return;
  const entry = { peaks: null, loading: true, retryAt: 0 };
  utilityLoopStereoLoads.set(canvas, entry);
  utilityLoopStereoQueue.push({ loopId, audio, canvas, entry });
  drainUtilityLoopStereoQueue();
}

function refreshUtilityLoopStereoWaveforms() {
  drainUtilityLoopStereoQueue();
  document.querySelectorAll('[data-loop-audio]').forEach(audio => {
    updateUtilityLoopStereoWaveform(audio.getAttribute('data-loop-audio'), audio);
  });
}

function isUtilityLoopTextEntry(element) {
  if (!(element instanceof HTMLElement)) return false;
  const tagName = String(element.tagName || '').toUpperCase();
  if (tagName === 'TEXTAREA') return true;
  if (element.isContentEditable) return true;
  if (tagName !== 'INPUT') return false;
  const type = String(element.getAttribute('type') || element.type || '').toLowerCase();
  return type !== 'range';
}

function focusUtilityLoopTimeline(loopId) {
  const timeline = document.querySelector(`[data-loop-timeline="${cssEscape(loopId || '')}"]`);
  if (!(timeline instanceof HTMLElement) || timeline.disabled) return;
  timeline.focus({ preventScroll: true });
}

function claimUtilityLoopSpaceOwnerFromTarget(target) {
  if (!(target instanceof HTMLElement) || isUtilityLoopTextEntry(target)) return false;
  const directLoopId = String(target.getAttribute?.('data-utility-loop-entry') || '');
  const loopEntry = directLoopId ? target : target.closest?.('[data-utility-loop-entry]');
  const loopId = directLoopId || String(loopEntry?.getAttribute?.('data-utility-loop-entry') || '');
  if (!loopId) return false;
  state.utility.loopSpaceOwnerId = loopId;
  return true;
}

function clearUtilityLoopSpaceOwner() {
  state.utility.loopSpaceOwnerId = '';
}

function collapseAllUtilityLoopGroups() {
  state.utility.collapsedLoopGroups = groupUtilityLoops(state.utility.loops || []).reduce((collapsedGroups, group) => {
    const groupKey = String(group?.key || '');
    if (groupKey) collapsedGroups[groupKey] = true;
    return collapsedGroups;
  }, {});
}

function setUtilityActiveTab(nextTab, skipAppearanceGuard = false) {
  const normalizedTab = String(nextTab || 'problematic-files');
  if (!skipAppearanceGuard && normalizedTab !== state.utility.activeTab && typeof confirmBackgroundAppearanceLeave === 'function' && !confirmBackgroundAppearanceLeave(() => {
    setUtilityActiveTab(normalizedTab, true);
    if (typeof loadActiveUtilityTab === 'function') loadActiveUtilityTab(true);
    if (typeof renderUtilityModalContent === 'function') renderUtilityModalContent();
  })) return state.utility.activeTab;
  if (state.utility.activeTab === 'loops' && normalizedTab !== 'loops') {
    if (typeof disposeMountedLoopActions === 'function') disposeMountedLoopActions(getUtilityModalElements()?.detail);
    clearUtilityLoopSpaceOwner();
  }
  if (state.utility.activeTab !== 'loops' && normalizedTab === 'loops') {
    collapseAllUtilityLoopGroups();
  }
  state.utility.activeTab = normalizedTab;
  return normalizedTab;
}

function resolveUtilityLoopSpaceOwner() {
  if (state.utility.activeTab !== 'loops') return false;
  const utilityOverlay = getUtilityModalElements()?.overlay;
  if (!utilityOverlay || utilityOverlay.hidden) return false;
  const loopId = String(state.utility.loopSpaceOwnerId || '');
  if (!loopId) return false;
  const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
  return audio ? loopId : false;
}

function handleUtilityLoopSpacePlayback(event) {
  claimUtilityLoopSpaceOwnerFromTarget(event?.target);
  const loopId = resolveUtilityLoopSpaceOwner();
  return loopId
    ? toggleUtilityLoopPlayback(loopId, { focusTimelineOnResume: false })
    : false;
}

function seekUtilityLoopPlayback(loopId, deltaSeconds) {
  const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId || '')}"]`);
  if (!audio) return false;
  const duration = Number(audio.duration) || 0;
  const current = Number(audio.currentTime) || 0;
  const next = Math.max(0, Math.min(duration || Math.max(0, current + deltaSeconds), current + deltaSeconds));
  audio.currentTime = next;
  audio._loopEditPreviousTimeSeconds = next;
  updateUtilityLoopPlayerUi(loopId);
  return true;
}

function pauseOtherUtilityLoopPlayback(activeAudio) {
  document.querySelectorAll('[data-loop-audio]').forEach(otherAudio => {
    if (otherAudio === activeAudio || otherAudio.paused) return;
    otherAudio.pause();
    const otherLoopId = String(otherAudio.getAttribute?.('data-loop-audio') || '');
    if (otherLoopId) updateUtilityLoopPlayerUi(otherLoopId);
  });
}

function toggleUtilityLoopPlayback(loopId, options = {}) {
  const focusTimelineOnResume = options.focusTimelineOnResume !== false;
  const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId || '')}"]`);
  if (!audio) return false;
  if (audio.paused || audio.ended) {
    pauseOtherUtilityLoopPlayback(audio);
    if (audio.ended) audio.currentTime = 0;
    const globalPlayback = typeof getPlayerPlaybackSnapshot === 'function'
      ? getPlayerPlaybackSnapshot()
      : null;
    const finishLoopPlaybackStart = () => {
      if (focusTimelineOnResume) focusUtilityLoopTimeline(loopId);
    };
    const reportPlaybackFailure = error => {
      if (audio.isConnected === false) return;
      const code = String(error?.name || 'PlaybackError');
      console.warn('[AlbumHaven][Loops] Playback start failed.', { code, mediaErrorCode: audio.error?.code || null });
      showToast('Unable to start loop playback. Please try again.', 'error', 6000);
      updateUtilityLoopPlayerUi(loopId);
    };
    if (
      globalPlayback
      && !globalPlayback.ended
      && typeof pausePlayerPlaybackForHandoff === 'function'
    ) {
      const priorMuted = Boolean(audio.muted);
      const handoff = Promise.resolve(pausePlayerPlaybackForHandoff(globalPlayback));
      audio.muted = true;
      const activatedPlayback = audio.play();
      Promise.all([handoff, activatedPlayback])
        .then(() => {
          audio.muted = priorMuted;
          finishLoopPlaybackStart();
        })
        .catch(error => {
          audio.pause();
          audio.muted = priorMuted;
          reportPlaybackFailure(error);
        });
    } else {
      audio.play().then(finishLoopPlaybackStart).catch(reportPlaybackFailure);
    }
  } else {
    audio.pause();
  }
  updateUtilityLoopPlayerUi(loopId);
  return true;
}

function handleUtilityLoopTimelineKeydown(event, loopId) {
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  if (event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space') {
    if (event.isComposing || event.repeat || event.shiftKey) return false;
    event.preventDefault();
    event.stopPropagation?.();
    return toggleUtilityLoopPlayback(loopId, { focusTimelineOnResume: false });
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
  const direction = event.key === 'ArrowLeft' ? -1 : 1;
  const stepSeconds = event.shiftKey ? 5 : 1;
  event.preventDefault();
  event.stopPropagation?.();
  return seekUtilityLoopPlayback(loopId, direction * stepSeconds);
}

function handleUtilityLoopKeyboardSeek(event) {
  if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target || isUtilityLoopTextEntry(target)) return false;
  const loopEntry = target.closest?.('[data-utility-loop-entry]');
  const loopId = String(loopEntry?.getAttribute?.('data-utility-loop-entry') || '');
  if (!loopId) return false;
  claimUtilityLoopSpaceOwnerFromTarget(target);
  const handled = handleUtilityLoopTimelineKeydown(event, loopId);
  const isSpace = event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space';
  if (handled && !isSpace) focusUtilityLoopTimeline(loopId);
  return handled;
}

function initializeUtilityLoopPlayer(loop) {
  if (!loop) return;
  const loopId = String(loop.id || '');
  const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId)}"]`);
  if (!audio) return;
  if (audio.dataset.bound === '1') {
    mountSavedLoopControls(loopId);
    return;
  }
  const playButton = document.querySelector(`[data-loop-play="${cssEscape(loopId)}"]`);
  const timeline = document.querySelector(`[data-loop-timeline="${cssEscape(loopId)}"]`);
  const loopEntry = playButton?.closest?.('[data-utility-loop-entry]')
    || timeline?.closest?.('[data-utility-loop-entry]');
  audio.dataset.bound = '1';
  audio.dataset.speed = '1';
  audio.dataset.pitch = '0';
  audio._loopEditPreviousTimeSeconds = Number(audio.currentTime) || 0;
  if ('preservesPitch' in audio) audio.preservesPitch = true;
  playButton?.addEventListener('click', () => {
    claimUtilityLoopSpaceOwnerFromTarget(playButton);
    toggleUtilityLoopPlayback(loopId);
  });
  loopEntry?.addEventListener('focusin', (event) => {
    claimUtilityLoopSpaceOwnerFromTarget(event.target);
  });
  timeline?.addEventListener('keydown', (event) => {
    handleUtilityLoopTimelineKeydown(event, loopId);
  });
  timeline?.addEventListener('input', () => {
    audio.currentTime = Number(timeline.value) || 0;
    audio._loopEditPreviousTimeSeconds = audio.currentTime;
    updateUtilityLoopPlayerUi(loopId);
  });
  audio.addEventListener('loadedmetadata', () => {
    updateUtilityLoopPlayerUi(loopId);
    updateUtilityLoopAudioRate(loopId);
  });
  audio.addEventListener('play', () => updateUtilityLoopPlayerUi(loopId));
  audio.addEventListener('pause', () => updateUtilityLoopPlayerUi(loopId));
  audio.addEventListener('timeupdate', () => {
    noteSavedLoopWholeRangePlaybackProgress(loopId, audio);
    updateUtilityLoopPlayerUi(loopId);
  });
  audio.addEventListener('ended', () => {
    if (state.utility.loopRepeatEnabled && String(state.utility.selectedLoopId || '') === loopId) {
      noteSavedLoopWholeRangeWrap(loopId);
      audio.currentTime = 0;
      audio._loopEditPreviousTimeSeconds = 0;
      audio.play().catch(() => {});
      return;
    }
    updateUtilityLoopPlayerUi(loopId);
  });
  mountSavedLoopControls(loopId);
  updateUtilityLoopRepeatButton(loopId);
  updateUtilityLoopPlayerUi(loopId);
  if (!state.utility.loopKeyboardSeekBound) {
    document.addEventListener('keydown', handleUtilityLoopKeyboardSeek);
    state.utility.loopKeyboardSeekBound = true;
  }
}

function updateUtilityLoopRepeatButton() {
  const activeLoopId = String(state.utility.selectedLoopId || '');
  const repeatEnabled = Boolean(state.utility.loopRepeatEnabled)
    && Boolean(activeLoopId);
  document.querySelectorAll('[data-toggle-loop-repeat]').forEach((button) => {
    const buttonLoopId = String(button.getAttribute('data-toggle-loop-repeat') || '');
    const isActive = repeatEnabled && buttonLoopId === activeLoopId;
    const audio = document.querySelector(
      `[data-loop-audio="${cssEscape(buttonLoopId)}"]`,
    );
    if (audio) audio.loop = false;
    const label = isActive ? 'Disable repeat' : 'Enable repeat';
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  });
}

function updateUtilityLoopAudioRate(loopId) {
  const selector = `[data-loop-audio="${cssEscape(loopId || '')}"]`;
  const audio = document.querySelector(selector);
  if (!audio) return;
  const speed = Number(audio.dataset.speed || '1') || 1;
  const pitch = Number(audio.dataset.pitch || '0') || 0;
  audio.playbackRate = Math.max(0.25, Math.min(2, Math.round(speed * 20) / 20));
  if ('preservesPitch' in audio) audio.preservesPitch = true;
  const speedValue = document.querySelector(`[data-loop-speed-value-button="${cssEscape(loopId || '')}"]`);
  const pitchValue = document.querySelector(`[data-loop-pitch-control="${cssEscape(loopId || '')}"] [data-loop-pitch-value]`);
  if (speedValue) speedValue.textContent = `${speed.toFixed(2).replace(/\.?0+$/, '')}x`;
  document.querySelectorAll(`[data-loop-speed-menu="${cssEscape(loopId || '')}"] [data-loop-speed-option]`).forEach((button) => {
    const optionValue = Number(button.getAttribute('data-loop-speed-option') || 0);
    button.classList.toggle('is-active', Math.abs(optionValue - speed) < 0.001);
  });
  if (pitchValue) pitchValue.textContent = `${pitch > 0 ? '+' : ''}${pitch} pst`;
}

function positionUtilityLoopSpeedMenu(loopId) {
  const trigger = document.querySelector(`[data-loop-speed-value-button="${cssEscape(loopId || '')}"]`);
  const menu = document.querySelector(`[data-loop-speed-menu="${cssEscape(loopId || '')}"]`);
  if (!trigger || !menu || menu.hidden) return;
  const activeOption = menu.querySelector('.is-active') || menu.querySelector('[data-loop-speed-option="1.00"]') || menu.querySelector('[data-loop-speed-option]');
  if (!activeOption) return;

  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();



  let left = triggerRect.left + (triggerRect.width / 2) - (menuRect.width / 2);
  const below = window.innerHeight - triggerRect.bottom - 8;
  const above = triggerRect.top - 8;
  const opensBelow = below >= menuRect.height || below >= above;
  menu.style.maxHeight = `${Math.max(0, (opensBelow ? below : above) - 6)}px`;
  const popupHeight = Math.min(menuRect.height, Math.max(0, (opensBelow ? below : above) - 6));
  let top = opensBelow ? triggerRect.bottom + 6 : triggerRect.top - popupHeight - 6;

  const padding = 8;
  const clamped = clampPositionToViewport(left, top, menuRect.width, popupHeight, padding);

  menu.style.left = `${clamped.left}px`;
  menu.style.top = `${clamped.top}px`;
  menu.style.visibility = '';
  if (typeof syncTriggerAnchor === 'function') syncTriggerAnchor(menu, trigger);
}

function updateUtilityLoopPlayerUi(loopId) {
  const id = String(loopId || '');
  const elements = getSavedLoopRangeElements(loopId);
  const audio = elements.audio;
  if (!audio) return;
  const playButton = document.querySelector(`[data-loop-play="${cssEscape(loopId || '')}"]`);
  const timeline = elements.timeline;
  const time = elements.playbackTime;
  const duration = Number(audio.duration) || 0;
  const current = Number(audio.currentTime) || 0;
  if (timeline) {
    timeline.max = String(Math.max(duration, 0.1));
    timeline.value = String(Math.min(current, duration || current));
  }
  updateUtilityLoopStereoWaveform(id, audio);
  const waveform = state.utility.savedLoopWaveforms?.[id];
  if (elements.canvas && waveform && state.utility.loopEditors?.[id]?.active) {
    drawCombinedLoopWaveform(elements.canvas, waveform, duration > 0 ? current / duration : 0);
  }
  if (time && !state.utility.loopEditors?.[id]?.active) {
    time.textContent = `${formatLoopTime(current)} / ${formatLoopTime(duration)}`;
  }
  if (playButton) {
    const icon = audio.paused ? '\u25B6' : '\u23F8';
    if (playButton.textContent !== icon) playButton.textContent = icon;
    playButton.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  }
}

const utilityLoopPitchPreviewRequestTokens = new WeakMap();

async function renderUtilityLoopPitchPreview(loopId, semitones) {
  const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId || '')}"]`);
  const pitchValue = document.querySelector(`[data-loop-pitch-control="${cssEscape(loopId || '')}"] [data-loop-pitch-value]`);
  if (!audio) return;
  const requestToken = Symbol('utility-loop-pitch-preview');
  utilityLoopPitchPreviewRequestTokens.set(audio, requestToken);
  const isLatestRequest = () => utilityLoopPitchPreviewRequestTokens.get(audio) === requestToken;
  const pitch = Math.max(-12, Math.min(12, Number(semitones) || 0));
  const wasPlayingWhenRequested = !audio.paused && !audio.ended;
  audio.dataset.pitch = String(pitch);
  if (pitchValue) pitchValue.textContent = 'Rendering...';
  updateUtilityLoopAudioRate(loopId);
  try {
    const response = await fetch('/loops/pitch-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loop_id: loopId, semitones: pitch }),
    });
    const data = await response.json().catch(() => ({}));
    if (!isLatestRequest()) return;
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Failed to render pitch preview');
    }
    const nextSrc = data.media_url || audio.dataset.originalSrc || '';
    const endedWhilePending = wasPlayingWhenRequested && audio.paused && audio.ended;
    const shouldResume = (!audio.paused && !audio.ended) || endedWhilePending;
    const previousTime = endedWhilePending
      ? 0
      : Math.max(0, Number(audio.currentTime) || 0);
    if (nextSrc && audio.getAttribute('src') !== nextSrc) {
      audio.addEventListener('loadedmetadata', () => {
        if (!isLatestRequest()) return;
        const duration = Number(audio.duration);
        audio.currentTime = Number.isFinite(duration) && duration >= 0
          ? Math.min(previousTime, duration)
          : previousTime;
        if (shouldResume) audio.play().catch(() => {});
      }, { once: true });
      audio.setAttribute('src', nextSrc);
      audio.load();
    } else if (shouldResume) {
      if (endedWhilePending) audio.currentTime = 0;
      audio.play().catch(() => {});
    }
  } catch (error) {
    if (!isLatestRequest()) return;
    console.error('[AlbumHaven][Loops] Failed to render pitch preview.', error);
    showToast(error.message || 'Failed to render pitch preview.', 'error', 4200);
  } finally {
    if (isLatestRequest()) updateUtilityLoopAudioRate(loopId);
  }
}

function getSavedLoopRangeElements(loopId) {
  const id = cssEscape(loopId || '');
  const root = document.querySelector(`[data-loop-range-owner="saved-loop-${id}"]`);
  const main = document.querySelector(`[data-saved-loop-main-surface="${id}"]`);
  return {
    root,
    main,
    actionRoot: document.querySelector(`[data-loop-action-owner="saved-loop-${id}"]`),
    audio: document.querySelector(`[data-loop-audio="${id}"]`),
    canvas: root?.querySelector('[data-loop-range-waveform]'),
    surface: root?.matches?.('[data-loop-range-surface]') ? root : root?.querySelector('[data-loop-range-surface]'),
    timeline: main?.querySelector('[data-loop-timeline]'),
    playbackTime: main?.querySelector('[data-loop-time]'),
    boundaryTimes: main?.querySelector('[data-loop-range-times]'),
  };
}

function getSavedLoopExpiryOwnerId(loopId) {
  return `saved-loop-${String(loopId || '')}`;
}

function noteSavedLoopWholeRangeWrap(loopId) {
  const id = String(loopId || '');
  if (!state.utility.loopEditors?.[id]?.active) return false;
  return loopEditSessionExpiryController.noteUntouchedWholeRangeWrap(
    getSavedLoopExpiryOwnerId(id),
  );
}

function noteSavedLoopWholeRangePlaybackProgress(loopId, audio) {
  if (!audio) return false;
  const currentSeconds = Math.max(0, Number(audio.currentTime) || 0);
  const previousSeconds = Math.max(0, Number(audio._loopEditPreviousTimeSeconds) || 0);
  const durationSeconds = getSavedLoopEditDuration(loopId);
  audio._loopEditPreviousTimeSeconds = currentSeconds;
  if (audio.paused || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return false;
  const nearEndSeconds = Math.max(0, durationSeconds - Math.min(0.5, durationSeconds * 0.1));
  const nearStartSeconds = Math.min(0.5, durationSeconds * 0.1);
  const crossedNativeRepeatBoundary = Boolean(audio.loop)
    && previousSeconds >= durationSeconds / 2
    && currentSeconds < durationSeconds / 2
    && currentSeconds < previousSeconds;
  if (
    !crossedNativeRepeatBoundary
    && (previousSeconds < nearEndSeconds || currentSeconds > nearStartSeconds)
  ) return false;
  return noteSavedLoopWholeRangeWrap(loopId);
}

function getSavedLoopRangeDuration(loopId, elements = getSavedLoopRangeElements(loopId)) {
  const loop = (state.utility.loops || []).find((item) => String(item.id || '') === String(loopId || ''));
  const audioDuration = Number(elements.audio?.duration);
  const sourceDuration = Number(loop?.duration_seconds);
  if (Number.isFinite(audioDuration) && audioDuration > 0) {
    return Number.isFinite(sourceDuration) && sourceDuration > 0 ? Math.min(audioDuration, sourceDuration) : audioDuration;
  }
  return Number.isFinite(sourceDuration) ? Math.max(0, sourceDuration) : 0;
}

function getSavedLoopEditDuration(loopId, elements = getSavedLoopRangeElements(loopId)) {
  const id = String(loopId || '');
  const editor = state.utility.loopEditors?.[id];
  const frozenDuration = Number(editor?.durationSeconds);
  if ((editor?.active || state.utility.savedLoopEditorBusy?.[id])
      && Number.isFinite(frozenDuration) && frozenDuration > 0) {
    return frozenDuration;
  }
  return getSavedLoopRangeDuration(id, elements);
}

function setSavedLoopEditorBusy(loopId, busy) {
  const id = String(loopId || '');
  state.utility.savedLoopEditorBusy ||= {};
  if (busy) state.utility.savedLoopEditorBusy[id] = true;
  else delete state.utility.savedLoopEditorBusy[id];
  const actionRoot = getSavedLoopRangeElements(id).actionRoot;
  actionRoot?._loopActionController?.update({
    enabled: true, canCreate: state.loopCreateAllowed === true, active: Boolean(state.utility.loopEditors?.[id]?.active), busy: Boolean(busy),
  });
  actionRoot?.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function syncSavedLoopRange(loopId, range) {
  const id = String(loopId || '');
  const elements = getSavedLoopRangeElements(id);
  const durationSeconds = getSavedLoopEditDuration(id, elements);
  let startSeconds = Math.max(0, Math.min(durationSeconds, Number(range?.startSeconds) || 0));
  let endSeconds = Math.max(0, Math.min(durationSeconds, Number(range?.endSeconds) || 0));
  if (startSeconds > endSeconds) [startSeconds, endSeconds] = [endSeconds, startSeconds];
  const minimum = Math.min(0.01, durationSeconds || 0.01);
  if (durationSeconds > 0 && endSeconds - startSeconds < minimum) {
    if (endSeconds + minimum <= durationSeconds) endSeconds += minimum;
    else startSeconds = Math.max(0, endSeconds - minimum);
  }
  const normalized = { startSeconds, endSeconds };
  state.utility.loopEditors ||= {};
  state.utility.loopEditors[id] = {
    ...(state.utility.loopEditors[id] || {}),
    ...normalized,
    durationSeconds,
  };
  if (elements.playbackTime) {
    elements.playbackTime.textContent = `${formatLoopTime(startSeconds, true)} - ${formatLoopTime(endSeconds, true)}`;
  }
  return state.utility.loopEditors[id];
}

function renewSavedLoopExpiryAfterBoundaryEdit(loopId, range) {
  const id = String(loopId || '');
  const editor = state.utility.loopEditors?.[id];
  if (!editor?.active) return false;
  const nextStart = Number(range?.startSeconds);
  const nextEnd = Number(range?.endSeconds);
  const startChanged = Number.isFinite(nextStart)
    && Math.abs(nextStart - Number(editor.startSeconds)) > 0.000001;
  const endChanged = Number.isFinite(nextEnd)
    && Math.abs(nextEnd - Number(editor.endSeconds)) > 0.000001;
  if (!startChanged && !endChanged) return false;
  return loopEditSessionExpiryController.renewAfterBoundaryEdit(
    getSavedLoopExpiryOwnerId(id),
  );
}

function expireSavedLoopCreation(loopId) {
  const id = String(loopId || '');
  if (!state.utility.loopEditors?.[id]?.active) return false;
  cancelSavedLoopCreation(id);
  const audio = getSavedLoopRangeElements(id).audio;
  if (audio && !audio.paused) audio.pause();
  updateUtilityLoopPlayerUi(id);
  return true;
}

function startSavedLoopExpirySession(loopId) {
  const id = String(loopId || '');
  loopEditSessionExpiryController.start({
    ownerId: getSavedLoopExpiryOwnerId(id),
    onExpire: () => expireSavedLoopCreation(id),
  });
}

function setSavedLoopEditMode(loopId, active) {
  const id = String(loopId || '');
  const elements = getSavedLoopRangeElements(id);
  const editor = state.utility.loopEditors?.[id] || syncSavedLoopRange(id, {
    startSeconds: 0, endSeconds: getSavedLoopRangeDuration(id, elements),
  });
  editor.active = Boolean(active);
  elements.main?.classList.toggle('is-loop-editing', editor.active);
  if (elements.surface) elements.surface.hidden = !editor.active;
  if (elements.timeline) elements.timeline.hidden = false;
  if (elements.playbackTime) elements.playbackTime.hidden = false;
  if (elements.boundaryTimes) elements.boundaryTimes.hidden = true;
  elements.actionRoot?._loopActionController?.update({
    enabled: true,
    canCreate: state.loopCreateAllowed === true,
    active: editor.active,
    busy: Boolean(state.utility.savedLoopEditorBusy?.[id]),
  });
  elements.actionRoot?.setAttribute('data-loop-action-state', editor.active ? 'editing' : 'idle');
  const reconciledRange = elements.root?._loopRangeController?.render(editor);
  if (reconciledRange) syncSavedLoopRange(id, reconciledRange);
  if (!editor.active) updateUtilityLoopPlayerUi(id);
}

function cancelSavedLoopCreation(loopId) {
  const id = String(loopId || '');
  loopEditSessionExpiryController.stop(getSavedLoopExpiryOwnerId(id));
  state.utility.savedLoopOpenEpoch ||= {};
  state.utility.savedLoopOpenEpoch[id] = (Number(state.utility.savedLoopOpenEpoch[id]) || 0) + 1;
  setSavedLoopEditMode(id, false);
  if (state.utility.savedLoopWaveforms) delete state.utility.savedLoopWaveforms[id];
}

function cancelActiveSavedLoopCreation() {
  const activeEditor = Object.entries(state.utility.loopEditors || {})
    .find(([, editor]) => Boolean(editor?.active));
  if (!activeEditor) return false;
  cancelSavedLoopCreation(activeEditor[0]);
  return true;
}

function handleSavedLoopEditKeydown(event) {
  if (
    !event
    || event.key !== 'Enter'
    || event.defaultPrevented
    || event.isComposing
    || event.repeat
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || state.utility.activeTab !== 'loops'
  ) return false;
  const utilityOverlay = getUtilityModalElements()?.overlay;
  if (!utilityOverlay || utilityOverlay.hidden) return false;
  const activeEditor = Object.entries(state.utility.loopEditors || {})
    .find(([, editor]) => Boolean(editor?.active));
  if (!activeEditor) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  const tagName = String(target?.tagName || '').toUpperCase();
  const inputType = String(target?.getAttribute?.('type') || target?.type || '').toLowerCase();
  const rangeHandle = target?.getAttribute?.('data-loop-range-handle');
  const nativeAction = ['BUTTON', 'A', 'SELECT'].includes(tagName)
    || (tagName === 'INPUT' && inputType !== 'range')
    || Boolean(target?.closest?.('button:not([data-loop-range-handle]), a, select, [role="button"], [role="menuitem"]'));
  if (nativeAction && !rangeHandle) return false;
  const isTextEntry = tagName === 'TEXTAREA'
    || Boolean(target?.isContentEditable)
    || (tagName === 'INPUT'
      && !['button', 'checkbox', 'color', 'file', 'hidden', 'radio', 'range', 'reset', 'submit'].includes(inputType));
  const targetDialog = target?.closest?.('[role="dialog"], dialog, [aria-modal="true"]') || null;
  if (isTextEntry || (targetDialog && !utilityOverlay.contains?.(target))) return false;
  event.preventDefault();
  event.stopPropagation?.();
  void createLoopFromSavedLoop(activeEditor[0]);
  return true;
}

function mountSavedLoopControls(loopId) {
  const id = String(loopId || '');
  const elements = getSavedLoopRangeElements(id);
  if (!elements.root || !elements.actionRoot) return elements;
  if (!elements.actionRoot._loopActionController) {
    elements.actionRoot._loopActionController = mountLoopEditActionControl({
      root: elements.actionRoot,
      enabled: true,
      canCreate: state.loopCreateAllowed === true,
      active: Boolean(state.utility.loopEditors?.[id]?.active),
      busy: Boolean(state.utility.savedLoopEditorBusy?.[id]),
      onEnter: () => openSavedLoopCreation(id),
      onCreate: () => createLoopFromSavedLoop(id),
      onCancel: () => cancelSavedLoopCreation(id),
    });
    elements.actionRoot.dataset.loopActionsBound = '1';
  }
  if (!elements.root._loopRangeController) {
    elements.root._loopRangeController = createLoopRangeController({
      root: elements.root,
      getDuration: () => getSavedLoopEditDuration(id),
      getRange: () => state.utility.loopEditors?.[id] || {
        startSeconds: 0, endSeconds: getSavedLoopEditDuration(id),
      },
      onRangeInteractionStart: () => {
        loopEditSessionExpiryController.renewAfterBoundaryEdit(`saved-loop-${id}`);
      },
      onRangePreview: (range) => {
        renewSavedLoopExpiryAfterBoundaryEdit(id, range);
        syncSavedLoopRange(id, range);
      },
      onRangeCommit: (range) => {
        renewSavedLoopExpiryAfterBoundaryEdit(id, range);
        syncSavedLoopRange(id, range);
      },
      onSeek: (seconds) => {
        if (!elements.audio) return;
        elements.audio.currentTime = Math.max(0, Math.min(
          getSavedLoopEditDuration(id),
          Number(seconds) || 0,
        ));
        elements.audio._loopEditPreviousTimeSeconds = elements.audio.currentTime;
        updateUtilityLoopPlayerUi(id);
      },
      onCancel: () => cancelSavedLoopCreation(id),
    });
  }
  setSavedLoopEditMode(id, Boolean(state.utility.loopEditors?.[id]?.active));
  return elements;
}

async function openSavedLoopCreation(loopId) {
  if (state.loopCreateAllowed === false) return;
  const id = String(loopId || '');
  const loop = (state.utility.loops || []).find((item) => String(item.id || '') === id);
  if (!loop || state.utility.savedLoopEditorBusy?.[id]) return false;
  state.utility.savedLoopOpenEpoch ||= {};
  const openEpoch = (Number(state.utility.savedLoopOpenEpoch[id]) || 0) + 1;
  state.utility.savedLoopOpenEpoch[id] = openEpoch;
  const sessionDurationSeconds = getSavedLoopRangeDuration(id);
  state.utility.loopEditors ||= {};
  state.utility.loopEditors[id] = {
    ...(state.utility.loopEditors[id] || {}),
    durationSeconds: sessionDurationSeconds,
  };
  setSavedLoopEditorBusy(id, true);
  let elements = null;
  try {
    elements = mountSavedLoopControls(id);
    syncSavedLoopRange(id, { startSeconds: 0, endSeconds: sessionDurationSeconds });
    const mountedActionController = elements.actionRoot?._loopActionController;
    const waveform = await loadSavedLoopWaveformPeaks(id);
    if (elements.actionRoot?._loopActionController !== mountedActionController) return false;
    if (!waveform) throw new Error('Failed to load saved loop waveform.');
    if (state.utility.savedLoopOpenEpoch[id] !== openEpoch
        || (typeof getUtilityModalElements === 'function' && getUtilityModalElements()?.overlay?.hidden)
        || (state.utility.activeTab && state.utility.activeTab !== 'loops')) return false;
    const currentElements = getSavedLoopRangeElements(id);
    if (currentElements.root !== elements.root) {
      elements = mountSavedLoopControls(id);
      if (!elements.root) return false;
      syncSavedLoopRange(id, state.utility.loopEditors[id]);
    }
    state.utility.savedLoopWaveforms ||= {};
    state.utility.savedLoopWaveforms[id] = waveform;
    const audioDuration = Number(elements.audio?.duration) || sessionDurationSeconds;
    const currentTime = Number(elements.audio?.currentTime) || 0;
    drawCombinedLoopWaveform(elements.canvas, waveform, audioDuration > 0 ? currentTime / audioDuration : 0);
    elements.root?._loopRangeController?.render(state.utility.loopEditors[id]);
    setSavedLoopEditMode(id, true);
    startSavedLoopExpirySession(id);
    return true;
  } catch (error) {
    if (state.utility.savedLoopOpenEpoch[id] !== openEpoch
        || (typeof getUtilityModalElements === 'function' && getUtilityModalElements()?.overlay?.hidden)
        || (state.utility.activeTab && state.utility.activeTab !== 'loops')) return false;
    setSavedLoopEditMode(id, false);
    console.error('[AlbumHaven][Loops] Failed to open saved-loop editor.', error);
    showToast(error.message || 'Failed to open loop editor.', 'error', 4200);
    return false;
  } finally {
    setSavedLoopEditorBusy(id, false);
  }
}

async function createLoopFromSavedLoop(loopId) {
  if (state.loopCreateAllowed === false) return;
  const loop = (state.utility.loops || []).find((item) => String(item.id || '') === String(loopId || ''));
  if (!loop) return;
  const id = String(loopId || '');
  if (state.utility.savedLoopEditorBusy?.[id]) return;
  const pendingRange = state.utility.loopEditors?.[id];
  if (pendingRange?.active) {
    const pendingStart = Number(pendingRange.startSeconds);
    const pendingEnd = Number(pendingRange.endSeconds);
    if (!Number.isFinite(pendingStart) || !Number.isFinite(pendingEnd)
        || pendingStart < 0 || pendingEnd <= pendingStart) {
      showToast('Enter a valid loop start and end.', 'error', 3200);
      return;
    }
  }
  const elements = mountSavedLoopControls(id);
  if (!state.utility.loopEditors?.[id]?.active) return openSavedLoopCreation(id);
  const startSeconds = Number(state.utility.loopEditors[id].startSeconds);
  const endSeconds = Number(state.utility.loopEditors[id].endSeconds);
  const duration = getSavedLoopRangeDuration(loopId, elements);
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
      || startSeconds < 0 || endSeconds > duration || endSeconds <= startSeconds) {
    showToast('Enter a valid loop start and end.', 'error', 3200);
    return;
  }
  setSavedLoopEditorBusy(id, true);
  try {
    const name = String(await showLoopNameDialog() || '').trim();
    if (!name) return;
    const response = await fetch('/loops/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        source_loop_id: loop.id,
        start_seconds: startSeconds,
        end_seconds: endSeconds,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Failed to save loop');
    state.utility.loopMutationGeneration = Number(state.utility.loopMutationGeneration || 0) + 1;
    state.utility.loops = Array.isArray(data.loops) ? data.loops : state.utility.loops;
    state.utility.selectedLoopId = String(data.loop?.id || state.utility.selectedLoopId || '');
    state.utility.selectedLoopGroupKey = data.loop ? buildUtilityLoopGroupKey(data.loop) : state.utility.selectedLoopGroupKey;
    state.utility.selectedLoopDetailMode = 'group';
    state.utility.loopsLoaded = true;
    setSavedLoopEditMode(id, false);
    loopEditSessionExpiryController.stop(getSavedLoopExpiryOwnerId(id));
    renderUtilityModalContent();
    showToast('Loop saved.', 'success', 2600);
  } catch (error) {
    console.error('[AlbumHaven][Loops] Failed to create loop from saved loop.', error);
    showToast(error.message || 'Failed to create loop.', 'error', 4200);
  } finally {
    setSavedLoopEditorBusy(id, false);
  }
}

async function deleteSavedLoop(loopId, { confirmed = false } = {}) {
  const id = String(loopId || '');
  if (!id || state.utility.allowedActions?.['library.loops.delete'] === false) return false;
  const loop = (state.utility.loops || []).find((item) => String(item.id || '') === id);
  if (!loop) return false;
  const deletedGroupKey = loop ? buildUtilityLoopGroupKey(loop) : '';
  const name = loop?.name || 'this loop';
  if (!confirmed && !await showLoopDeleteConfirmDialog(name)) return false;
  const audio = document.querySelector(`[data-loop-audio="${cssEscape(id)}"]`);
  audio?.pause();
  try {
    const response = await fetch('/loops/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loop_id: id }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Failed to remove loop');
    loopEditSessionExpiryController.stop(getSavedLoopExpiryOwnerId(id));
    state.utility.loopMutationGeneration = Number(state.utility.loopMutationGeneration || 0) + 1;
    state.utility.loops = Array.isArray(data.loops) ? data.loops : (state.utility.loops || []).filter((item) => String(item.id || '') !== id);
    state.utility.loopsLoaded = true;
    const replacementInGroup = deletedGroupKey
      ? (state.utility.loops || []).find((item) => buildUtilityLoopGroupKey(item) === deletedGroupKey)
      : null;
    state.utility.selectedLoopId = String(replacementInGroup?.id || state.utility.loops[0]?.id || '');
    state.utility.selectedLoopGroupKey = String(replacementInGroup ? buildUtilityLoopGroupKey(replacementInGroup) : groupUtilityLoops(state.utility.loops || [])[0]?.key || '');
    state.utility.selectedLoopDetailMode = 'group';
    renderUtilityModalContent();
    showToast('Loop removed.', 'success', 2400);
    return true;
  } catch (error) {
    console.error('[AlbumHaven][Loops] Failed to remove loop.', error);
    showToast(error.message || 'Failed to remove loop.', 'error', 4200);
    return false;
  }
}

function getUtilityLoopOrderScope(songKey, loops = state.utility.loops || []) {
  const members = loops.filter(loop => loop.song_key === songKey);
  const revision = members[0]?.order_revision;
  if (!members.length || !members.every(loop => canReorderUtilityLoop(loop) && loop.order_revision === revision)) return null;
  return { songKey, revision, loops: members };
}

function replaceUtilityLoopSong(loops, songKey, members) {
  const next = [];
  let inserted = false;
  for (const loop of loops) {
    if (loop.song_key !== songKey) next.push(loop);
    else if (!inserted) { next.push(...members); inserted = true; }
  }
  if (!inserted) next.push(...members);
  return next;
}

function buildReorderedUtilityLoops(loops, draggedItem, targetItem, position) {
  if (!['before', 'after'].includes(position) || draggedItem?.type !== 'loop' || targetItem?.type !== 'loop') return null;
  const songKey = String(draggedItem.groupKey || '');
  if (!songKey || songKey !== targetItem.groupKey || draggedItem.id === targetItem.id) return null;
  const scope = getUtilityLoopOrderScope(songKey, loops);
  if (!scope) return null;
  const members = scope.loops.slice();
  const from = members.findIndex(loop => String(loop.id) === String(draggedItem.id));
  if (from < 0 || !members.some(loop => String(loop.id) === String(targetItem.id))) return null;
  const [moving] = members.splice(from, 1);
  const to = members.findIndex(loop => String(loop.id) === String(targetItem.id));
  members.splice(to + (position === 'after' ? 1 : 0), 0, moving);
  if (members.every((loop, index) => loop.id === scope.loops[index].id)) return null;
  return replaceUtilityLoopSong(loops, songKey, members);
}

function captureUtilityLoopOrderView(songKey) {
  const els = getUtilityModalElements();
  return { songKey, panel: els.detail?.querySelector('.utility-loop-entry-list'), detail: els.detail,
    generation: Number(state.utility.loopViewGeneration || 0) };
}

function isUtilityLoopOrderViewCurrent(view) {
  const els = getUtilityModalElements();
  return state.utility.activeTab === 'loops' && !els.overlay?.hidden
    && String(state.utility.selectedLoopGroupKey || '') === view.songKey
    && Number(state.utility.loopViewGeneration || 0) === view.generation
    && view.panel && els.detail === view.detail
    && els.detail?.querySelector('.utility-loop-entry-list') === view.panel;
}

function createUtilityLoopMarkupNode(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild;
}

function moveUtilityLoopNode(parent, node, before = null) {
  if (node === before || (node.parentNode === parent && node.nextElementSibling === before)) return;
  if (typeof parent.moveBefore === 'function' && node.parentNode === parent) {
    parent.moveBefore(node, before);
    return;
  }
  // Native media retains playback across this synchronous move; do not seek or restart it.
  parent.insertBefore(node, before);
}

function reconcileUtilityLoopOrderView(view, members) {
  if (!isUtilityLoopOrderViewCurrent(view)) return;
  const els = getUtilityModalElements();
  const focused = document.activeElement;
  const scrolls = [els.list, els.detail].filter(Boolean).map(node => [node, node.scrollTop]);
  const before = new Map(Array.from(view.panel.children, node => [node, node.getBoundingClientRect().top]));
  const ids = new Set(members.map(loop => String(loop.id)));
  const panels = new Map(Array.from(view.panel.querySelectorAll('[data-utility-loop-entry]'), node => [node.getAttribute('data-utility-loop-entry'), node]));
  for (const [id, node] of panels) {
    if (ids.has(id)) continue;
    if (typeof disposeMountedLoopActions === 'function') disposeMountedLoopActions(node);
    if (typeof loopEditSessionExpiryController !== 'undefined') loopEditSessionExpiryController.stop(`saved-loop-${id}`);
    node.querySelector('[data-loop-audio]')?.pause();
    node.remove();
    delete state.utility.loopEditors?.[id];
  }
  let panelCursor = view.panel.firstElementChild;
  for (const loop of members) {
    const id = String(loop.id);
    const node = panels.get(id) || createUtilityLoopMarkupNode(buildUtilityLoopEntry(loop));
    if (!node) continue;
    moveUtilityLoopNode(view.panel, node, panelCursor);
    panelCursor = node.nextElementSibling;
    if (!panels.has(id)) initializeUtilityLoopPlayer(loop);
  }
  const treeChildren = Array.from(els.list?.querySelectorAll('[data-utility-loop-id]') || [])
    .filter(node => node.getAttribute('data-utility-loop-group-key') === view.songKey);
  const treeParent = treeChildren[0]?.parentNode || Array.from(els.list?.querySelectorAll('[data-loop-tree-song]') || [])
    .find(node => node.getAttribute('data-loop-tree-song') === view.songKey);
  if (treeParent) {
    const existing = new Map(treeChildren.map(node => [node.getAttribute('data-utility-loop-id'), node]));
    const visibleIds = new Set(getFilteredUtilityLoops().map(loop => String(loop.id)));
    for (const [id, node] of existing) if (!ids.has(id) || !visibleIds.has(id)) node.remove();
    let treeCursor = treeParent.firstElementChild;
    for (const loop of members) {
      if (!visibleIds.has(String(loop.id))) continue;
      const node = existing.get(String(loop.id)) || createUtilityLoopMarkupNode(buildUtilityLoopTreeChild(loop, view.songKey));
      if (node) {
        moveUtilityLoopNode(treeParent, node, treeCursor);
        treeCursor = node.nextElementSibling;
      }
    }
  }
  if (!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    for (const node of Array.from(view.panel.children)) {
      const delta = before.has(node) ? before.get(node) - node.getBoundingClientRect().top : 0;
      if (delta) node.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 220, easing: 'ease-out' });
    }
  }
  if (focused && document.activeElement !== focused && els.overlay?.contains?.(focused)) focused.focus?.({ preventScroll: true });
  scrolls.forEach(([node, scrollTop]) => { node.scrollTop = scrollTop; });
  syncUtilityLoopPanelVisibility();
  bindUtilityLoopDragAndDrop();
  syncUtilityLoopMoveButtons();
}

function normalizeUtilityLoopOrderResponse(data, songKey) {
  if (data?.song_key !== songKey || !Number.isSafeInteger(data.order_revision) || data.order_revision < 0
      || !Array.isArray(data.ordered_ids) || !Array.isArray(data.loops)) return null;
  const ids = data.ordered_ids;
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length || data.loops.length !== ids.length) return null;
  const byId = new Map(data.loops.map(loop => [String(loop?.id || ''), loop]));
  if (byId.size !== ids.length || ids.some(id => !byId.has(id) || byId.get(id).song_key !== songKey)) return null;
  return ids.map(id => ({ ...byId.get(id), order_revision: data.order_revision }));
}

async function moveUtilityLoop(loopId, direction) {
  if (!['up', 'down'].includes(direction)) return false;
  const loop = (state.utility.loops || []).find(item => String(item.id) === String(loopId));
  const scope = loop && getUtilityLoopOrderScope(loop.song_key);
  if (!scope) return false;
  const index = scope.loops.findIndex(item => item.id === loop.id);
  const target = scope.loops[index + (direction === 'up' ? -1 : 1)];
  if (!target) return false;
  return reorderUtilityLoops({ type: 'loop', id: loop.id, groupKey: scope.songKey },
    { type: 'loop', id: target.id, groupKey: scope.songKey }, direction === 'up' ? 'before' : 'after');
}

async function reorderUtilityLoops(draggedItem, targetItem, position) {
  const previousLoops = (state.utility.loops || []).slice();
  const nextLoops = buildReorderedUtilityLoops(previousLoops, draggedItem, targetItem, position);
  if (!nextLoops) return false;
  const songKey = String(draggedItem.groupKey);
  const scope = getUtilityLoopOrderScope(songKey, previousLoops);
  state.utility.loopOrderPending ||= {};
  if (state.utility.loopOrderPending[songKey]) return false;
  const utilityOwner = state.utility;
  const dataGeneration = Number(utilityOwner.loopDataGeneration || 0);
  utilityOwner.loopMutationGeneration = Number(utilityOwner.loopMutationGeneration || 0) + 1;
  const ownsCache = () => state.utility === utilityOwner && Number(state.utility.loopDataGeneration || 0) === dataGeneration;
  const token = {};
  state.utility.loopOrderPending[songKey] = token;
  const view = captureUtilityLoopOrderView(songKey);
  const ordered = nextLoops.filter(loop => loop.song_key === songKey);
  state.utility.loops = nextLoops;
  reconcileUtilityLoopOrderView(view, ordered);
  try {
    const response = await fetch('/loops/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        song_key: songKey, expected_revision: scope.revision,
        ordered_ids: ordered.map(loop => String(loop.id)),
      }),
    });
    const data = await response.json().catch(() => ({}));
    const authoritative = normalizeUtilityLoopOrderResponse(data, songKey);
    if ((!response.ok || !data.ok) && response.status !== 409) throw new Error(data.error || 'Failed to reorder loops');
    if (!authoritative) throw new Error('Unable to reconcile saved loop order. Reload Loops and try again.');
    const currentRevision = (state.utility.loops || []).find(loop => loop.song_key === songKey)?.order_revision;
    if (ownsCache() && Number.isSafeInteger(currentRevision) && data.order_revision >= currentRevision) {
      state.utility.loops = replaceUtilityLoopSong(state.utility.loops || [], songKey, authoritative);
      reconcileUtilityLoopOrderView(view, authoritative);
    }
    if (response.status === 409) showToast('Loop order changed. The latest order is shown; try your move again.', 'error', 4200);
    return response.ok && data.ok === true;
  } catch (error) {
    const current = (state.utility.loops || []).filter(loop => loop.song_key === songKey);
    if (ownsCache() && current.length && current.every(loop => loop.order_revision === scope.revision)) {
      state.utility.loops = replaceUtilityLoopSong(state.utility.loops || [], songKey, scope.loops);
      reconcileUtilityLoopOrderView(view, scope.loops);
    }
    showToast(error.message || 'Failed to reorder loops.', 'error', 4200);
    return false;
  } finally {
    if (utilityOwner.loopOrderPending[songKey] === token) delete utilityOwner.loopOrderPending[songKey];
    syncUtilityLoopMoveButtons();
    clearUtilityLoopDragState();
    syncUtilityLoopDragUi();
  }
}
