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

function setUtilityActiveTab(nextTab) {
  const normalizedTab = String(nextTab || 'problematic-files');
  if (state.utility.activeTab === 'loops' && normalizedTab !== 'loops') {
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

function toggleUtilityLoopPlayback(loopId, options = {}) {
  const focusTimelineOnResume = options.focusTimelineOnResume !== false;
  const audio = document.querySelector(`[data-loop-audio="${cssEscape(loopId || '')}"]`);
  if (!audio) return false;
  if (audio.paused || audio.ended) {
    if (audio.ended) audio.currentTime = 0;
    const globalPlayback = typeof getPlayerPlaybackSnapshot === 'function'
      ? getPlayerPlaybackSnapshot()
      : null;
    const finishLoopPlaybackStart = () => {
      if (focusTimelineOnResume) focusUtilityLoopTimeline(loopId);
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
        .catch(() => {
          audio.pause();
          audio.muted = priorMuted;
          updateUtilityLoopPlayerUi(loopId);
        });
    } else {
      audio.play().then(finishLoopPlaybackStart).catch(() => {});
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
  if (!audio || audio.dataset.bound === '1') return;
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
  const activeRect = activeOption.getBoundingClientRect();
  const activeOffset = activeOption.offsetTop + (activeRect.height / 2);

  let left = triggerRect.left + (triggerRect.width / 2) - (menuRect.width / 2);
  let top = triggerRect.top + (triggerRect.height / 2) - activeOffset;

  const padding = 8;
  const clamped = clampPositionToViewport(left, top, menuRect.width, menuRect.height, padding);

  menu.style.left = `${clamped.left}px`;
  menu.style.top = `${clamped.top}px`;
  menu.style.visibility = '';
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
  const waveform = state.utility.savedLoopWaveforms?.[id];
  if (elements.canvas && waveform && state.utility.loopEditors?.[id]?.active) {
    drawCombinedLoopWaveform(elements.canvas, waveform, duration > 0 ? current / duration : 0);
  }
  if (time && !state.utility.loopEditors?.[id]?.active) {
    time.textContent = `${formatLoopTime(current)} / ${formatLoopTime(duration)}`;
  }
  if (playButton) {
    playButton.textContent = audio.paused ? '\u25B6' : '\u23F8';
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
  if (Number.isFinite(audioDuration) && audioDuration > 0) return audioDuration;
  return Math.max(0, Number(loop?.duration_seconds) || 0);
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
    enabled: true, active: Boolean(state.utility.loopEditors?.[id]?.active), busy: Boolean(busy),
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
    const waveform = await loadSavedLoopWaveformPeaks(id);
    if (!waveform) throw new Error('Failed to load saved loop waveform.');
    if (state.utility.savedLoopOpenEpoch[id] !== openEpoch) return false;
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
    if (state.utility.savedLoopOpenEpoch[id] !== openEpoch) return false;
    setSavedLoopEditMode(id, false);
    console.error('[AlbumHaven][Loops] Failed to open saved-loop editor.', error);
    showToast(error.message || 'Failed to open loop editor.', 'error', 4200);
    return false;
  } finally {
    setSavedLoopEditorBusy(id, false);
  }
}

async function createLoopFromSavedLoop(loopId) {
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
    state.utility.loops = Array.isArray(data.loops) ? data.loops : state.utility.loops;
    state.utility.selectedLoopId = String(data.loop?.id || state.utility.selectedLoopId || '');
    state.utility.selectedLoopGroupKey = data.loop ? buildUtilityLoopGroupKey(data.loop) : state.utility.selectedLoopGroupKey;
    state.utility.selectedLoopDetailMode = 'group';
    state.utility.loopsLoaded = true;
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

async function deleteSavedLoop(loopId) {
  const id = String(loopId || '');
  if (!id) return;
  const loop = (state.utility.loops || []).find((item) => String(item.id || '') === id);
  const deletedGroupKey = loop ? buildUtilityLoopGroupKey(loop) : '';
  const name = loop?.name || 'this loop';
  if (!await showLoopDeleteConfirmDialog(name)) return;
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
  } catch (error) {
    console.error('[AlbumHaven][Loops] Failed to remove loop.', error);
    showToast(error.message || 'Failed to remove loop.', 'error', 4200);
  }
}

function buildReorderedUtilityLoops(loops, draggedItem, targetItem, position) {
  const dragType = String(draggedItem?.type || '');
  const fromId = String(draggedItem?.id || '');
  const fromGroupKey = String(draggedItem?.groupKey || '');
  const targetType = String(targetItem?.type || '');
  const toId = String(targetItem?.id || '');
  const toGroupKey = String(targetItem?.groupKey || '');
  const insertPosition = position === 'before' ? 'before' : 'after';
  if (!fromId || !toId || (fromId === toId && dragType === targetType) || !Array.isArray(loops) || loops.length < 2) return null;
  const groups = groupUtilityLoops(loops);
  if (dragType === 'group' && targetType === 'group') {
    const fromIndex = groups.findIndex((group) => String(group?.key || '') === fromId);
    const targetIndex = groups.findIndex((group) => String(group?.key || '') === toId);
    if (fromIndex < 0 || targetIndex < 0) return null;
    const nextGroups = groups.slice();
    const [draggedGroup] = nextGroups.splice(fromIndex, 1);
    if (!draggedGroup) return null;
    const nextTargetIndex = nextGroups.findIndex((group) => String(group?.key || '') === toId);
    if (nextTargetIndex < 0) return null;
    nextGroups.splice(insertPosition === 'before' ? nextTargetIndex : nextTargetIndex + 1, 0, draggedGroup);
    return nextGroups.flatMap((group) => group.loops || []);
  }
  if (dragType === 'loop' && targetType === 'loop' && fromGroupKey && fromGroupKey === toGroupKey) {
    const nextGroups = groups.map((group) => ({
      ...group,
      loops: Array.isArray(group.loops) ? group.loops.slice() : [],
    }));
    const targetGroup = nextGroups.find((group) => String(group?.key || '') === fromGroupKey);
    if (!targetGroup || !Array.isArray(targetGroup.loops)) return null;
    const fromIndex = targetGroup.loops.findIndex((loop) => String(loop?.id || '') === fromId);
    const targetIndex = targetGroup.loops.findIndex((loop) => String(loop?.id || '') === toId);
    if (fromIndex < 0 || targetIndex < 0) return null;
    const [draggedLoop] = targetGroup.loops.splice(fromIndex, 1);
    if (!draggedLoop) return null;
    const nextTargetIndex = targetGroup.loops.findIndex((loop) => String(loop?.id || '') === toId);
    if (nextTargetIndex < 0) return null;
    targetGroup.loops.splice(insertPosition === 'before' ? nextTargetIndex : nextTargetIndex + 1, 0, draggedLoop);
    return nextGroups.flatMap((group) => group.loops || []);
  }
  return null;
}

function rerenderUtilityLoopListOnly() {
  if (state.utility.activeTab !== 'loops') return;
  const els = getUtilityModalElements();
  if (!els.overlay || els.overlay.hidden) return;
  renderUtilityModalContent();
}

async function reorderUtilityLoops(draggedItem, targetItem, position) {
  const previousLoops = Array.isArray(state.utility.loops) ? state.utility.loops.slice() : [];
  const nextLoops = buildReorderedUtilityLoops(previousLoops, draggedItem, targetItem, position);
  if (!nextLoops) return false;

  state.utility.loops = nextLoops;
  state.utility.loopsLoaded = true;
  rerenderUtilityLoopListOnly();

  try {
    const response = await fetch('/loops/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ordered_ids: nextLoops.map((item) => String(item?.id || '')).filter(Boolean),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Failed to reorder loops');
    state.utility.loops = Array.isArray(data.loops) ? data.loops : nextLoops;
    state.utility.loopsLoaded = true;
    rerenderUtilityLoopListOnly();
    return true;
  } catch (error) {
    console.error('[AlbumHaven][Loops] Failed to reorder loops.', error);
    state.utility.loops = previousLoops;
    state.utility.loopsLoaded = true;
    rerenderUtilityLoopListOnly();
    showToast(error.message || 'Failed to reorder loops.', 'error', 4200);
    return false;
  }
}
