function escapeLoopControlAttribute(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildLoopEditActionControl({
  ownerId = '',
  enterLabel = 'Create a loop',
  createLabel = 'Create loop',
  cancelLabel = 'Cancel loop creation',
} = {}) {
  return `
    <span class="loop-edit-actions" data-loop-action-owner="${escapeLoopControlAttribute(ownerId)}" data-loop-action-state="idle" data-loop-action-engaged="false">
      <span class="loop-edit-action-pod" data-loop-action-pod>
        <button class="loop-edit-action loop-edit-action-enter" type="button" data-loop-action="enter" aria-label="${escapeLoopControlAttribute(enterLabel)}" aria-pressed="false" title="${escapeLoopControlAttribute(enterLabel)}"><span class="loop-edit-action-icon is-scissors" aria-hidden="true"></span></button>
        <span class="loop-edit-action-expanded" data-loop-action-expanded hidden>
          <button class="loop-edit-action loop-edit-action-create" type="button" data-loop-action="create" aria-label="${escapeLoopControlAttribute(createLabel)}" title="${escapeLoopControlAttribute(createLabel)}"><span class="loop-edit-action-icon is-scissors" aria-hidden="true"></span></button>
          <span class="loop-edit-action-divider" data-loop-action-divider aria-hidden="true"></span>
          <button class="loop-edit-action loop-edit-action-cancel" type="button" data-loop-action="cancel" aria-label="${escapeLoopControlAttribute(cancelLabel)}" title="${escapeLoopControlAttribute(cancelLabel)}"><span class="loop-edit-action-icon is-cancel" aria-hidden="true"></span></button>
        </span>
      </span>
    </span>
  `;
}

function mountLoopEditActionControl({
  root, interactionRoot, contextKey = '', enabled = true, canCreate = true, active = false, busy = false,
  disabledLabel = 'Start playing the track to edit the loop', onEnter, onCreate, onCancel,
} = {}) {
  if (!root) return null;
  const compound = interactionRoot || root.closest?.('[data-playback-control-cluster]') || root;
  const ownerDocument = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const enter = root.querySelector('[data-loop-action="enter"]');
  const create = root.querySelector('[data-loop-action="create"]');
  const cancel = root.querySelector('[data-loop-action="cancel"]');
  const expanded = root.querySelector?.('[data-loop-action-expanded]') || null;
  const listeners = [];
  const touchQuery = typeof matchMedia === 'function' ? matchMedia('(hover: none), (pointer: coarse)') : null;
  let currentEnabled = Boolean(enabled), currentCanCreate = Boolean(canCreate);
  let currentActive = Boolean(active), currentBusy = Boolean(busy), currentEngaged = false;
  let pointerWithin = false, focusWithin = false, keyboardInput = true, destroyed = false;
  let revealTimer = null, foldTimer = null;
  let currentContextKey = String(contextKey || '');
  const listen = (target, name, listener) => {
    target?.addEventListener?.(name, listener);
    listeners.push([target, name, listener]);
  };
  const clearTimers = () => {
    if (revealTimer !== null) clearTimeout(revealTimer);
    if (foldTimer !== null) clearTimeout(foldTimer);
    revealTimer = foldTimer = null;
  };
  const renderEngagement = (engaged) => {
    currentEngaged = Boolean(engaged && currentCanCreate && !destroyed);
    root.setAttribute?.('data-loop-action-engaged', String(currentEngaged));
    compound.setAttribute?.('data-loop-action-engaged', String(currentEngaged));
    [enter, create, cancel].forEach(button => button?.setAttribute?.('tabindex', currentEngaged ? '0' : '-1'));
  };
  const retained = () => Boolean(touchQuery?.matches || (keyboardInput && focusWithin));
  const leave = () => {
    clearTimers();
    if (!currentCanCreate) return renderEngagement(false);
    if (pointerWithin || retained()) return renderEngagement(true);
    if (!currentActive) return renderEngagement(false);
    foldTimer = setTimeout(() => {
      foldTimer = null;
      if (!pointerWithin && !retained()) renderEngagement(false);
    }, 500);
  };
  const visit = () => {
    clearTimers();
    if (!currentCanCreate) return renderEngagement(false);
    if (currentActive || retained()) return renderEngagement(true);
    if (currentEngaged) return;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      if (pointerWithin) renderEngagement(true);
    }, 300);
  };
  const update = (next = {}) => {
    if (destroyed) return;
    const wasActive = currentActive;
    const wasAllowed = currentCanCreate;
    const contextChanged = Object.prototype.hasOwnProperty.call(next, 'contextKey') && String(next.contextKey || '') !== currentContextKey;
    if (contextChanged) currentContextKey = String(next.contextKey || '');
    if (Object.prototype.hasOwnProperty.call(next, 'enabled')) currentEnabled = Boolean(next.enabled);
    if (Object.prototype.hasOwnProperty.call(next, 'canCreate')) currentCanCreate = Boolean(next.canCreate);
    if (Object.prototype.hasOwnProperty.call(next, 'active')) currentActive = Boolean(next.active);
    if (Object.prototype.hasOwnProperty.call(next, 'busy')) currentBusy = Boolean(next.busy);
    if (next.reset || contextChanged || !currentCanCreate || (wasActive && !currentActive)) {
      clearTimers();
      renderEngagement(retained() && currentCanCreate);
    } else if ((!wasActive && currentActive) || (!wasAllowed && currentCanCreate)) {
      pointerWithin = pointerWithin || Boolean(compound.matches?.(':hover'));
      focusWithin = focusWithin || Boolean(ownerDocument?.activeElement && compound.contains?.(ownerDocument.activeElement));
      clearTimers();
      renderEngagement(retained() || (currentActive && pointerWithin));
    } else if (retained()) renderEngagement(true);
    root.hidden = !currentCanCreate;
    const unavailable = !currentEnabled || !currentCanCreate;
    const disabled = unavailable || currentBusy;
    if (enter) {
      enter.hidden = currentActive;
      enter.disabled = disabled;
      enter.setAttribute('aria-pressed', String(currentActive));
      enter.setAttribute('aria-disabled', String(disabled));
      enter.setAttribute('title', unavailable ? disabledLabel : enter.getAttribute('aria-label'));
    }
    if (expanded) expanded.hidden = !currentActive;
    [create, cancel].forEach(button => {
      if (!button) return;
      button.hidden = !currentActive;
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
    });
    root.classList?.toggle('is-active', currentActive);
    root.classList?.toggle('is-busy', currentBusy);
    root.classList?.toggle('is-disabled', unavailable);
    root.setAttribute?.('aria-busy', String(currentBusy));
    root.setAttribute?.('data-loop-action-state', unavailable ? 'disabled' : (currentActive ? 'editing' : 'idle'));
    if (compound !== root) compound.setAttribute?.('data-loop-action-state', currentActive ? 'editing' : 'idle');
    compound.setAttribute?.('data-loop-create-allowed', String(currentCanCreate));
  };
  listen(enter, 'click', () => { if (currentCanCreate && currentEnabled && !currentBusy && !currentActive) onEnter?.(); });
  listen(create, 'click', () => { if (currentCanCreate && currentEnabled && !currentBusy && currentActive) onCreate?.(); });
  listen(cancel, 'click', () => { if (currentCanCreate && currentEnabled && !currentBusy && currentActive) onCancel?.(); });
  listen(compound, 'pointerenter', () => { pointerWithin = true; visit(); });
  listen(compound, 'pointerleave', () => { pointerWithin = false; leave(); });
  listen(compound, 'pointerdown', () => { keyboardInput = false; focusWithin = false; });
  const keyboard = () => { keyboardInput = true; };
  listen(ownerDocument, 'keydown', keyboard);
  listen(compound, 'keydown', keyboard);
  listen(compound, 'focusin', () => {
    focusWithin = true;
    if (keyboardInput) { clearTimers(); renderEngagement(true); }
  });
  listen(compound, 'focusout', event => {
    focusWithin = Boolean(event?.relatedTarget && compound.contains?.(event.relatedTarget));
    leave();
  });
  listen(touchQuery, 'change', () => { if (retained()) visit(); else leave(); });
  renderEngagement(Boolean(touchQuery?.matches));
  update({ enabled, canCreate, active, busy });
  return {
    update,
    destroy() {
      clearTimers();
      destroyed = true;
      listeners.forEach(([target, name, listener]) => target?.removeEventListener?.(name, listener));
      listeners.length = 0;
    },
  };
}

function normalizeLoopRange(range, duration) {
  const limit = Math.max(0, Number(duration) || 0);
  const minimum = Math.min(0.01, limit || 0.01);
  let startSeconds = Math.max(0, Math.min(limit, Number(range?.startSeconds) || 0));
  let endSeconds = Math.max(0, Math.min(limit, Number(range?.endSeconds) || 0));
  if (startSeconds > endSeconds) [startSeconds, endSeconds] = [endSeconds, startSeconds];
  if (endSeconds - startSeconds < minimum && limit > 0) {
    if (endSeconds + minimum <= limit) endSeconds += minimum;
    else startSeconds = Math.max(0, endSeconds - minimum);
  }
  return { startSeconds, endSeconds };
}

function createLoopRangeController({
  root,
  getDuration,
  getRange,
  onRangeInteractionStart,
  onRangePreview,
  onRangeCommit,
  onSeek,
  onCancel,
} = {}) {
  if (!root) return null;
  const surface = root.matches?.('[data-loop-range-surface]')
    ? root
    : root.querySelector('[data-loop-range-surface]');
  const handles = {
    start: root.querySelector('[data-loop-range-handle="start"]'),
    end: root.querySelector('[data-loop-range-handle="end"]'),
  };
  const times = {
    start: root.querySelector('[data-loop-range-time="start"]'),
    end: root.querySelector('[data-loop-range-time="end"]'),
  };
  let currentDuration = Math.max(0, Number(getDuration?.()) || 0);
  const initialRange = getRange?.();
  const initialRangeDuration = Math.max(0, Number(initialRange?.durationSeconds) || 0);
  const initialCandidate = initialRangeDuration > 0 && currentDuration > 0
    && Math.abs(initialRangeDuration - currentDuration) > 0.001
    ? {
      startSeconds: Number(initialRange?.startSeconds) * (currentDuration / initialRangeDuration),
      endSeconds: Number(initialRange?.endSeconds) * (currentDuration / initialRangeDuration),
    }
    : initialRange;
  let currentRange = normalizeLoopRange(initialCandidate, currentDuration);
  let drag = null;
  let pendingSurfaceGesture = null;
  let queuedClientX = null;
  let frame = 0;
  let documentDragListenersAttached = false;
  const elementListeners = [];
  const listen = (element, name, handler) => {
    element?.addEventListener?.(name, handler);
    elementListeners.push([element, name, handler]);
  };

  const render = (range = currentRange) => {
    const duration = Math.max(0, Number(getDuration?.()) || 0);
    let candidate = range;
    if (currentDuration > 0 && duration > 0 && Math.abs(duration - currentDuration) > 0.001) {
      const scale = duration / currentDuration;
      candidate = {
        startSeconds: Number(range?.startSeconds) * scale,
        endSeconds: Number(range?.endSeconds) * scale,
      };
    }
    currentDuration = duration;
    currentRange = normalizeLoopRange(candidate, duration);
    ['start', 'end'].forEach((role) => {
      const value = currentRange[`${role}Seconds`];
      const handle = handles[role];
      if (handle) {
        const percent = duration > 0 ? (value / duration) * 100 : 0;
        handle.style.left = `${percent}%`;
        handle.setAttribute('aria-valuemin', '0');
        handle.setAttribute('aria-valuemax', String(duration));
        handle.setAttribute('aria-valuenow', String(value));
        handle.setAttribute('aria-valuetext', `${role === 'start' ? 'Loop start' : 'Loop end'} ${formatLoopTime(value, true)}`);
      }
      if (times[role]) times[role].textContent = formatLoopTime(value, true);
    });
    root.style?.setProperty?.('--loop-range-start', `${duration > 0 ? (currentRange.startSeconds / duration) * 100 : 0}%`);
    root.style?.setProperty?.('--loop-range-end', `${duration > 0 ? (currentRange.endSeconds / duration) * 100 : 100}%`);
    return currentRange;
  };

  const clientXToSeconds = (clientX) => {
    const rect = surface?.getBoundingClientRect?.() || { left: 0, width: 1 };
    const ratio = Math.max(0, Math.min(1, (Number(clientX) - rect.left) / Math.max(1, rect.width)));
    return ratio * Math.max(0, Number(getDuration?.()) || 0);
  };

  const previewAt = (clientX) => {
    if (!drag) return;
    const value = clientXToSeconds(clientX);
    const stationaryRole = drag.role === 'start' ? 'end' : 'start';
    const stationary = currentRange[`${stationaryRole}Seconds`];
    const next = value <= stationary
      ? { startSeconds: value, endSeconds: stationary }
      : { startSeconds: stationary, endSeconds: value };
    drag.role = value <= stationary ? 'start' : 'end';
    render(next);
    onRangePreview?.({ ...currentRange });
  };

  const onPointerMove = (event) => {
    if (pendingSurfaceGesture) {
      if (event.pointerId != null && pendingSurfaceGesture.pointerId !== event.pointerId) return;
      if (Math.abs(Number(event.clientX) - pendingSurfaceGesture.originClientX) < 3) return;
      drag = {
        role: pendingSurfaceGesture.role,
        originRole: pendingSurfaceGesture.role,
        pointerId: pendingSurfaceGesture.pointerId,
      };
      root.setAttribute?.('data-loop-range-front', pendingSurfaceGesture.role);
      pendingSurfaceGesture = null;
    }
    if (!drag || (event.pointerId != null && drag.pointerId !== event.pointerId)) return;
    queuedClientX = event.clientX;
    if (frame) return;
    const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => { callback(); return 0; };
    frame = schedule(() => {
      frame = 0;
      const clientX = queuedClientX;
      queuedClientX = null;
      previewAt(clientX);
    });
  };

  const onPointerUp = (event) => {
    if (pendingSurfaceGesture
        && (event.pointerId == null || pendingSurfaceGesture.pointerId === event.pointerId)) {
      const clickClientX = pendingSurfaceGesture.originClientX;
      pendingSurfaceGesture = null;
      detachDocumentDragListeners();
      onSeek?.(clientXToSeconds(clickClientX));
      return;
    }
    finishDrag(event, false);
  };
  const onPointerCancel = (event) => {
    if (pendingSurfaceGesture
        && (event.pointerId == null || pendingSurfaceGesture.pointerId === event.pointerId)) {
      pendingSurfaceGesture = null;
      detachDocumentDragListeners();
      return;
    }
    finishDrag(event, true);
  };
  const attachDocumentDragListeners = () => {
    if (documentDragListenersAttached) return;
    documentDragListenersAttached = true;
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
  };
  const detachDocumentDragListeners = () => {
    if (!documentDragListenersAttached) return;
    documentDragListenersAttached = false;
    document.removeEventListener?.('pointermove', onPointerMove);
    document.removeEventListener?.('pointerup', onPointerUp);
    document.removeEventListener?.('pointercancel', onPointerCancel);
  };

  function finishDrag(event, cancelled = false) {
    if (!drag || (event?.pointerId != null && drag.pointerId !== event.pointerId)) return;
    if (!cancelled && queuedClientX != null) {
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = 0;
      previewAt(queuedClientX);
    }
    const originRole = drag.originRole;
    drag = null;
    queuedClientX = null;
    detachDocumentDragListeners();
    if (cancelled) onCancel?.();
    else {
      root.setAttribute?.('data-loop-range-front', originRole === 'start' ? 'end' : 'start');
      onRangeCommit?.({ ...currentRange });
    }
  }

  Object.entries(handles).forEach(([role, handle]) => {
    listen(handle, 'pointerdown', (event) => {
      event.preventDefault?.();
      onRangeInteractionStart?.(role);
      render(currentRange);
      drag = { role, originRole: role, pointerId: event.pointerId };
      root.setAttribute?.('data-loop-range-front', role);
      attachDocumentDragListeners();
      handle.setPointerCapture?.(event.pointerId);
      handle.focus?.();
    });
    listen(handle, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault?.();
        event.stopPropagation?.();
        onCancel?.();
        return;
      }
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault?.();
      onRangeInteractionStart?.(role);
      const duration = Math.max(0, Number(getDuration?.()) || 0);
      const step = event.shiftKey ? Math.max(0.1, duration / 20) : Math.max(0.01, duration / 200);
      const value = currentRange[`${role}Seconds`] + (event.key === 'ArrowRight' ? step : -step);
      const stationaryRole = role === 'start' ? 'end' : 'start';
      const stationary = currentRange[`${stationaryRole}Seconds`];
      const crossed = role === 'start' ? value > stationary : value < stationary;
      const next = normalizeLoopRange(value <= stationary
        ? { startSeconds: value, endSeconds: stationary }
        : { startSeconds: stationary, endSeconds: value }, duration);
      render(next);
      if (crossed) handles[stationaryRole]?.focus?.();
      onRangePreview?.({ ...currentRange });
      onRangeCommit?.({ ...currentRange });
    });
  });
  listen(surface, 'pointerdown', (event) => {
    if (event.target?.closest?.('[data-loop-range-handle]')) return;
    event.preventDefault?.();
    render(currentRange);
    const value = clientXToSeconds(event.clientX);
    const role = Math.abs(value - currentRange.startSeconds) <= Math.abs(value - currentRange.endSeconds)
      ? 'start'
      : 'end';
    pendingSurfaceGesture = {
      originClientX: Number(event.clientX),
      pointerId: event.pointerId,
      role,
    };
    attachDocumentDragListeners();
    surface.setPointerCapture?.(event.pointerId);
  });
  listen(root, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault?.();
    onCancel?.();
  });
  render(currentRange);
  root.setAttribute?.('data-loop-range-front', 'start');
  if (currentRange.startSeconds !== Number(getRange?.()?.startSeconds)
      || currentRange.endSeconds !== Number(getRange?.()?.endSeconds)) {
    onRangePreview?.({ ...currentRange });
  }
  return {
    render,
    getRange: () => ({ ...currentRange }),
    destroy() {
      if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = 0;
      queuedClientX = null;
      drag = null;
      pendingSurfaceGesture = null;
      detachDocumentDragListeners();
      elementListeners.forEach(([element, name, handler]) => element?.removeEventListener?.(name, handler));
      elementListeners.length = 0;
    },
  };
}

function drawCombinedLoopWaveform(canvas, waveform, progressRatio = 0) {
  if (!canvas) return;
  const width = Math.max(1, canvas.clientWidth || canvas.width || 1);
  const height = Math.max(1, canvas.clientHeight || canvas.height || 1);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, width, height);
  const left = Array.isArray(waveform?.left) ? waveform.left : [];
  const right = Array.isArray(waveform?.right) ? waveform.right : [];
  const count = Math.max(left.length, right.length, 1);
  const barWidth = width / count;
  const center = Math.floor(height / 2);
  const maxHalfHeight = Math.max(0, Math.floor((height - 1) / 2));
  const savedColors = typeof getSavedAppearancePlayerColors === 'function' ? getSavedAppearancePlayerColors() : null;
  const fill = savedColors?.fill || (typeof state !== 'undefined' && state.player?.appearance?.waveformFillColor) || '#9be18a';
  const edge = savedColors?.edge || (typeof state !== 'undefined' && state.player?.appearance?.waveformEdgeColor) || '#86efac';
  const drawBars = () => {
    for (let index = 0; index < count; index += 1) {
      const leftPeak = Math.abs(Number(left[index] ?? right[index] ?? 0));
      const rightPeak = Math.abs(Number(right[index] ?? left[index] ?? 0));
      const peak = Math.max(0.025, Math.min(1, (leftPeak + rightPeak) / 2));
      const halfHeight = Math.min(maxHalfHeight, Math.max(1, Math.round(peak * height * 0.46)));
      context.fillRect(
        index * barWidth,
        center - halfHeight,
        Math.max(1, barWidth * 0.72),
        (2 * halfHeight) + 1,
      );
    }
  };
  context.fillStyle = fill;
  context.globalAlpha = 0.6;
  context.shadowBlur = 0;
  drawBars();

  const clampedProgress = Math.max(0, Math.min(1, Number(progressRatio) || 0));
  const playheadX = width * clampedProgress;
  if (playheadX > 0) {
    context.save();
    context.beginPath();
    context.rect(0, 0, playheadX, height);
    context.clip();
    context.globalAlpha = 0.95;
    context.shadowColor = fill;
    context.shadowBlur = 6;
    drawBars();
    context.restore();
  }

  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.strokeStyle = edge;
  context.shadowColor = edge;
  context.shadowBlur = 10;
  context.lineWidth = 2.4;
  context.beginPath();
  context.moveTo(playheadX, 0);
  context.lineTo(playheadX, height);
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = edge;
  context.beginPath();
  context.arc(playheadX, height * 0.5, 3.2, 0, Math.PI * 2);
  context.fill();
}
