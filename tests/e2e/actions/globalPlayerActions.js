import { expect } from '@playwright/test';

function parseDisplayedPlayerTime(label) {
  const currentLabel = String(label || '').split('/')[0].trim();
  const parts = currentLabel.split(':').map((value) => Number(value));
  if (!parts.length || parts.some((value) => !Number.isFinite(value) || value < 0)) {
    return Number.NaN;
  }
  return parts.reduce((total, value) => (total * 60) + value, 0);
}

export class GlobalPlayerActions {
  constructor(globalPlayer) {
    this.globalPlayer = globalPlayer;
  }

  async installLoopEditExpiryClock() {
    await this.globalPlayer.page.clock.install({ time: Date.now() });
    await this.globalPlayer.appKeyboardSurface.focus();
  }

  async advanceLoopEditExpiryClock(milliseconds) {
    await this.globalPlayer.page.clock.fastForward(milliseconds);
  }

  async elapseLoopEditExpiryClockWithoutTimers(milliseconds) {
    const currentTime = await this.globalPlayer.readWallClockTimeMs();
    await this.globalPlayer.page.clock.setSystemTime(currentTime + milliseconds);
  }

  async reactivateAfterBackgrounding() {
    const backgroundPage = await this.globalPlayer.page.context().newPage();
    try {
      await backgroundPage.bringToFront();
      await this.globalPlayer.page.bringToFront();
      await this.globalPlayer.appKeyboardSurface.click({ position: { x: 1, y: 1 } });
    } finally {
      await backgroundPage.close();
    }
  }

  async waitForCurrentTrack(expected, options = {}) {
    await this.globalPlayer.waitForPageCondition((selectors) => {
      if (typeof state === 'undefined') return false;
      const current = state.player?.current || null;
      if (!current) return false;
      if (selectors.path && String(current.path || '') !== selectors.path) return false;
      if (selectors.trackTitle && String(current.title || '') !== selectors.trackTitle) return false;
      const visibleTitle = (document.querySelector(selectors.titleSelector)?.textContent || '').trim();
      if (selectors.visibleTitle && visibleTitle !== selectors.visibleTitle) return false;
      return true;
    }, {
      timeout: options.timeout || 60000,
    }, {
      path: String(expected.path || ''),
      trackTitle: String(expected.trackTitle || ''),
      visibleTitle: String(expected.visibleTitle || ''),
      titleSelector: this.globalPlayer.titleSelector,
    });
  }

  async expectVisiblePlayer(options = {}) {
    await expect(this.globalPlayer.player).toBeVisible({
      timeout: options.timeout || 60000,
    });
  }

  async expectForegroundPlayerAndToggle(surfaceName, expectedState, options = {}) {
    const surface = this.globalPlayer.foregroundSurface(surfaceName);
    await expect(surface).toBeVisible({ timeout: options.timeout || 60000 });
    await this.expectVisiblePlayer(options);

    const checkpoint = await this.globalPlayer.readForegroundLaneCheckpoint(surfaceName);
    expect(Math.abs(checkpoint.player.bottom - checkpoint.viewport.height)).toBeLessThanOrEqual(1);
    expect(checkpoint.player.height).toBeGreaterThan(0);
    expect(checkpoint.surface.height).toBeGreaterThan(0);
    expect(checkpoint.surface.bottom).toBeLessThanOrEqual(checkpoint.player.top + 1);

    await this.globalPlayer.playButton.click({ trial: true });
    await this.globalPlayer.playButton.click();
    await this.waitForPlaybackState(expectedState, options);
    await expect(surface).toBeVisible({ timeout: options.timeout || 60000 });
    return checkpoint;
  }

  async waitForPlaybackState(expectedState, options = {}) {
    await this.globalPlayer.waitForPageCondition((expected) => {
      if (typeof getPlayerPlaybackSnapshot !== 'function') return false;
      const playback = getPlayerPlaybackSnapshot();
      const currentTime = Number(playback.currentTime) || 0;
      if (expected.paused === false && playback.paused) return false;
      if (expected.paused === true && !playback.paused) return false;
      if (Number.isFinite(expected.minimumCurrentTime) && currentTime < expected.minimumCurrentTime) return false;
      return true;
    }, {
      timeout: options.timeout || 60000,
    }, {
      paused: expectedState.paused,
      minimumCurrentTime: Number(expectedState.minimumCurrentTime),
    });
  }

  async readCurrentPlaybackSummary() {
    return this.globalPlayer.readPlaybackSummary();
  }

  async waitForFullTrackTiming(options = {}) {
    await expect.poll(
      async () => (await this.globalPlayer.readPlaybackTiming()).duration,
      { timeout: options.timeout || 60000 },
    ).toBeGreaterThan(0);
    return this.globalPlayer.readPlaybackTiming();
  }

  async clickOwnershipSurface() {
    const before = await this.readCurrentPlaybackSummary();
    await expect(this.globalPlayer.ownershipSurface).toBeVisible();
    await this.globalPlayer.ownershipSurface.click();
    const after = await this.readCurrentPlaybackSummary();
    expect(after).toEqual(before);
    return { before, after };
  }

  async readDisplayedCurrentTimeSeconds() {
    const value = parseDisplayedPlayerTime(await this.globalPlayer.time.textContent());
    if (!Number.isFinite(value)) {
      throw new Error('Expected the global player to expose a readable current-time label.');
    }
    return value;
  }

  async seekToSeconds(seconds, options = {}) {
    const targetSeconds = Number(seconds);
    const timing = await this.globalPlayer.readPlaybackTiming();
    if (!Number.isFinite(targetSeconds) || targetSeconds < 0 || !(timing.duration > 0)) {
      throw new RangeError(`Cannot seek to ${JSON.stringify(seconds)} seconds with duration ${timing.duration}.`);
    }
    const bounds = await this.globalPlayer.timeline.boundingBox();
    if (!bounds || !(bounds.width > 0 && bounds.height > 0)) {
      throw new Error('The visible player timeline has no clickable bounds.');
    }
    const ratio = Math.min(1, targetSeconds / timing.duration);
    const beforeSeek = await this.globalPlayer.readSeekBaselineCheckpoint();
    await this.globalPlayer.timeline.click({
      position: {
        x: Math.max(1, Math.min(bounds.width - 1, bounds.width * ratio)),
        y: bounds.height / 2,
      },
    });
    await this.globalPlayer.waitForPageCondition((expected) => {
      if (typeof getPlayerPlaybackSnapshot !== 'function'
          || typeof getStreamingPlaybackSnapshot !== 'function') return false;
      const playback = getPlayerPlaybackSnapshot();
      const streaming = getStreamingPlaybackSnapshot();
      const currentTime = Number(playback.currentTime || 0);
      const firstFrameAtMs = Number(streaming.diagnostics?.firstFrameAtMs || 0);
      const seekCommittedAtMs = Number(streaming.diagnostics?.seekCommittedAtMs || 0);
      return streaming.mode === 'playing'
        && Number(streaming.generation || 0) === expected.generation
        && seekCommittedAtMs > expected.seekCommittedAtMs
        && firstFrameAtMs > expected.firstFrameAtMs
        && Math.abs(currentTime - expected.targetSeconds) <= expected.toleranceSeconds;
    }, { timeout: options.timeout || 60000 }, {
      targetSeconds,
      toleranceSeconds: Number(options.toleranceSeconds || 1),
      generation: beforeSeek.generation,
      firstFrameAtMs: beforeSeek.firstFrameAtMs,
      seekCommittedAtMs: beforeSeek.seekCommittedAtMs,
    });
    const completion = await this.globalPlayer.readSeekCompletionCheckpoint();
    return {
      targetSeconds,
      durationBeforeSeek: timing.duration,
      durationAfterSeek: completion.duration,
      timelineValueAfterSeek: completion.timelineValue,
      startedAtMs: completion.seekRequestedAtMs,
      completedAtMs: completion.completedAtMs,
      elapsedMs: Math.max(0, completion.seekCommittedAtMs - completion.seekRequestedAtMs),
      generation: completion.generation,
      firstFrameAtMs: completion.firstFrameAtMs,
      seekRequestedAtMs: completion.seekRequestedAtMs,
      seekCommittedAtMs: completion.seekCommittedAtMs,
      seekSilentFrames: completion.seekSilentFrames,
      seekCapture: completion.seekCapture,
      continuityStreamIdBeforeSeek: beforeSeek.continuityStreamId,
      visibleReadinessErrors: await this.globalPlayer.readinessErrorToasts.allTextContents(),
    };
  }

  async togglePlaybackWithSpace(expectedState, options = {}) {
    await this.globalPlayer.appKeyboardSurface.press('Space');
    await this.waitForPlaybackState(expectedState, options);
    return this.readCurrentPlaybackSummary();
  }

  async waitForDisplayedPlaybackAdvance(afterSeconds) {
    await expect.poll(() => this.readDisplayedCurrentTimeSeconds()).toBeGreaterThan(afterSeconds);
    return this.readDisplayedCurrentTimeSeconds();
  }

  async waitForRenderedWaveform(options = {}) {
    const selector = this.globalPlayer.waveformCanvasSelector;
    const expectedPath = String(options.path || '');
    await this.globalPlayer.waitForPageCondition(({ canvasSelector, path }) => {
      const canvas = document.querySelector(canvasSelector);
      const compactPeaks = state.player?.waveform?.compactPeaks;
      const peaks = compactPeaks?.data;
      if (!(canvas instanceof HTMLCanvasElement) || canvas.hidden
          || (path && String(compactPeaks?.path || '') !== path)
          || !Array.isArray(peaks?.left) || peaks.left.length !== 280
          || !Array.isArray(peaks?.right) || peaks.right.length !== 280) return false;
      const context = canvas.getContext('2d');
      if (!context || canvas.width <= 0 || canvas.height <= 0) return false;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const playback = getStreamingPlaybackSnapshot();
      const progress = Number(playback.duration) > 0
        ? Math.max(0, Math.min(1, Number(playback.currentTime || 0) / Number(playback.duration)))
        : 0;
      const playheadX = Math.round(progress * canvas.width);
      for (let pixel = 0; pixel < pixels.length / 4; pixel += 1) {
        const x = pixel % canvas.width;
        if (Math.abs(x - playheadX) > 4 && pixels[(pixel * 4) + 3] > 0) return true;
      }
      return false;
    }, { timeout: options.timeout || 60000 }, { canvasSelector: selector, path: expectedPath });
    return this.globalPlayer.readRenderedWaveformCheckpoint();
  }

  async waitForWaveformPlayheadAt(seconds, options = {}) {
    const targetSeconds = Number(seconds);
    const toleranceSeconds = Number(options.toleranceSeconds || 0.3);
    const canvasSelector = this.globalPlayer.waveformCanvasSelector;
    const timelineSelector = this.globalPlayer.timelineSelector;
    const handle = await this.globalPlayer.page.waitForFunction((expected) => {
      const canvas = document.querySelector(expected.canvasSelector);
      if (!(canvas instanceof HTMLCanvasElement) || canvas.hidden) return false;
      if (expected.path && String(state.player?.current?.path || '') !== expected.path) return false;
      const playback = getStreamingPlaybackSnapshot();
      const duration = Number(playback.duration || 0);
      const currentTime = Number(playback.currentTime || 0);
      if (!(duration > 0) || Math.abs(currentTime - expected.targetSeconds) > expected.toleranceSeconds) {
        return false;
      }
      const expectedX = Math.round((currentTime / duration) * canvas.width);
      const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels) return false;
      let topPlayheadPixels = 0;
      for (let y = 0; y < Math.min(4, canvas.height); y += 1) {
        for (let x = Math.max(0, expectedX - 4); x <= Math.min(canvas.width - 1, expectedX + 4); x += 1) {
          if (pixels[((y * canvas.width + x) * 4) + 3] > 0) topPlayheadPixels += 1;
        }
      }
      if (topPlayheadPixels <= 0) return false;
      const timeline = document.querySelector(expected.timelineSelector);
      return {
        currentTime,
        duration,
        playheadX: expectedX,
        timelineValue: Number(timeline?.value || 0),
        topPlayheadPixels,
        width: canvas.width,
      };
    }, {
      canvasSelector,
      path: String(options.path || ''),
      targetSeconds,
      timelineSelector,
      toleranceSeconds,
    }, { timeout: options.timeout || 60000 });
    try {
      return await handle.jsonValue();
    } finally {
      await handle.dispose();
    }
  }

  async waitForStreamingContinuity(path, options = {}) {
    const expectedPath = String(path || '');
    if (!expectedPath) throw new TypeError('Expected a queued continuity track path.');
    await this.globalPlayer.waitForPageCondition((expected) => {
      if (typeof state === 'undefined' || typeof getStreamingPlaybackSnapshot !== 'function') {
        return false;
      }
      const streaming = state.player?.streaming || {};
      return Number(streaming.generation || 0) === expected.generation
        && String(streaming.roles?.continuity?.track?.path || '') === expected.path
        && !streaming.pendingPromotion;
    }, { timeout: options.timeout || 60000 }, {
      generation: Number(options.generation || 0),
      path: expectedPath,
    });
  }

  async waitForDecodedCover(options = {}) {
    return this.globalPlayer.waitForDecodedCover(options);
  }

  async openCurrentAlbumFromCover() {
    await this.globalPlayer.coverButton.click();
  }

  async waitForReloadPlaybackOutcome(expected, options = {}) {
    const expectedPath = String(expected.path || '');
    try {
      await this.globalPlayer.waitForPageCondition((path) => {
        if (typeof state === 'undefined'
            || typeof getPlayerPlaybackSnapshot !== 'function'
            || typeof getStreamingPlaybackSnapshot !== 'function') return false;
        const playback = getPlayerPlaybackSnapshot();
        const streaming = getStreamingPlaybackSnapshot();
        const role = state.player?.streaming?.roles?.current || null;
        if (String(role?.track?.path || '') !== path
            || Number(role?.generation || 0) <= 0
            || Number(role?.streamId || 0) <= 0) return false;
        const contextState = String(streaming.diagnostics?.contextState || '');
        const active = !playback.paused
          && streaming.mode === 'playing'
          && contextState === 'running';
        const blocked = Boolean(playback.paused)
          && streaming.mode === 'paused'
          && contextState === 'suspended';
        return active || blocked;
      }, { timeout: options.timeout || 60000 }, expectedPath);
    } catch (error) {
      const checkpoint = await this.globalPlayer.readReloadPlaybackCheckpoint();
      throw new Error(
        `Reload playback did not settle for ${JSON.stringify(expectedPath)}; final checkpoint ${JSON.stringify(checkpoint)}.`,
        { cause: error },
      );
    }
    return this.globalPlayer.readReloadPlaybackCheckpoint();
  }

  async reloadAndWaitForRestoredTrack(expected, options = {}) {
    const preReload = await this.globalPlayer.readPlaybackTiming();
    await this.globalPlayer.page.reload({ waitUntil: 'domcontentloaded' });
    await this.waitForCurrentTrack(expected, options);
    await this.expectVisiblePlayer(options);
    if (options.paused === true) {
      await this.waitForPlaybackState({ paused: true }, options);
      return this.readCurrentPlaybackSummary();
    }
    const initialRestore = await this.waitForReloadPlaybackOutcome(expected, options);
    if (!initialRestore.paused) {
      return {
        ...(await this.readCurrentPlaybackSummary()),
        reloadOutcome: 'autoplay',
        initialRestore,
        preReload,
      };
    }
    if (options.requireAutoplay === true) {
      throw new Error(`Expected Chrome to allow reload autoplay, received ${JSON.stringify(initialRestore)}.`);
    }
    await this.resumeIfPaused(options);
    return {
      ...(await this.readCurrentPlaybackSummary()),
      reloadOutcome: 'blocked-resumed',
      initialRestore,
      preReload,
    };
  }

  async pauseIfPlaying(options = {}) {
    const playback = await this.readCurrentPlaybackSummary();
    const playbackLabel = String(await this.globalPlayer.playButton.getAttribute('aria-label') || '').trim();
    if (playback.paused) {
      return;
    }
    if (!['Play', 'Pause'].includes(playbackLabel)) {
      throw new Error(`Expected the global player control to expose Play or Pause, received ${JSON.stringify(playbackLabel)}.`);
    }
    await this.globalPlayer.playButton.click();
    await this.waitForPlaybackState({ paused: true }, options);
  }

  async resumeIfPaused(options = {}) {
    const playback = await this.readCurrentPlaybackSummary();
    const playbackLabel = String(await this.globalPlayer.playButton.getAttribute('aria-label') || '').trim();
    if (!playback.paused) {
      return;
    }
    if (!['Play', 'Pause'].includes(playbackLabel)) {
      throw new Error(`Expected the global player control to expose Play or Pause, received ${JSON.stringify(playbackLabel)}.`);
    }
    await this.globalPlayer.playButton.click();
    await this.waitForPlaybackState({ paused: false }, options);
  }

  async openLoopEditor(options = {}) {
    await expect(this.globalPlayer.legacyLoopButton).toHaveCount(0);
    await expect(this.globalPlayer.legacyLoopPopup).toHaveCount(0);
    await this.globalPlayer.loopScissorsButton.click();
    await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'editing');
    await expect(this.globalPlayer.loopCreateButton).toBeVisible({ timeout: options.timeout || 60000 });
    await expect(this.globalPlayer.loopCancelButton).toBeVisible({ timeout: options.timeout || 60000 });
    await expect(this.globalPlayer.loopEditSurface).toBeVisible({ timeout: options.timeout || 60000 });
    await expect(this.globalPlayer.loopStartHandle).toBeVisible({ timeout: options.timeout || 60000 });
    await expect(this.globalPlayer.loopEndHandle).toBeVisible({ timeout: options.timeout || 60000 });
    await expect(this.globalPlayer.time).toBeVisible({ timeout: options.timeout || 60000 });
    const snapshot = await this.globalPlayer.readLoopEditorSnapshot();
    await expect(this.globalPlayer.time).toContainText(snapshot.startLabel);
    await expect(this.globalPlayer.time).toContainText(snapshot.endLabel);
    return snapshot;
  }

  async expectLoopEditorActive(options = {}) {
    await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'editing', {
      timeout: options.timeout || 60000,
    });
    await expect(this.globalPlayer.loopEditSurface).toBeVisible({ timeout: options.timeout || 60000 });
    return this.readCurrentPlaybackSummary();
  }

  async expectLoopEditorInactive(options = {}) {
    await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'idle', {
      timeout: options.timeout || 60000,
    });
    await expect(this.globalPlayer.loopEditSurface).toBeHidden({ timeout: options.timeout || 60000 });
    await expect(this.globalPlayer.loopStartHandle).toBeHidden({ timeout: options.timeout || 60000 });
    await expect(this.globalPlayer.loopEndHandle).toBeHidden({ timeout: options.timeout || 60000 });
    return this.readCurrentPlaybackSummary();
  }

  async waitForAutomaticLoopEditorExpiry(options = {}) {
    await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'idle', {
      timeout: options.timeout || 60000,
    });
    await expect(this.globalPlayer.loopEditSurface).toBeHidden({ timeout: options.timeout || 60000 });
    await this.waitForPlaybackState({ paused: true }, options);
    return this.readCurrentPlaybackSummary();
  }

  async readLoopActionVisualState() {
    return this.globalPlayer.readLoopActionVisualSnapshot();
  }

  async expectUnavailableLoopAction() {
    const requests = [];
    const observe = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') requests.push(request);
    };
    this.globalPlayer.page.on('request', observe);
    try {
      await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'disabled');
      await expect(this.globalPlayer.loopScissorsButton).toBeDisabled();
      await expect(this.globalPlayer.loopScissorsButton)
        .toHaveAttribute('title', 'Start playing the track to edit the loop');
      const bounds = await this.globalPlayer.loopScissorsButton.boundingBox();
      if (!bounds) throw new Error('Expected the disabled loop action to have rendered bounds.');
      await this.globalPlayer.page.mouse.click(
        bounds.x + (bounds.width / 2),
        bounds.y + (bounds.height / 2),
      );
      await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'disabled');
    } finally {
      this.globalPlayer.page.off('request', observe);
    }
    return { requestCount: requests.length, visual: await this.readLoopActionVisualState() };
  }

  async expectAvailableLoopAction(options = {}) {
    const timeout = options.timeout || 60000;
    await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'idle', {
      timeout,
    });
    await expect(this.globalPlayer.loopScissorsButton).toBeEnabled({ timeout });
    return this.readLoopActionVisualState();
  }

  async hoverLoopAction(target = 'enter') {
    const locator = target === 'create'
      ? this.globalPlayer.loopCreateButton
      : target === 'cancel'
        ? this.globalPlayer.loopCancelButton
        : this.globalPlayer.loopScissorsButton;
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error(`Expected the ${target} loop action to have rendered bounds.`);
    await this.globalPlayer.page.mouse.move(
      bounds.x + (bounds.width / 2),
      bounds.y + (bounds.height / 2),
    );
    return this.readLoopActionVisualState();
  }

  async moveAwayFromLoopAction() {
    await this.globalPlayer.page.mouse.move(2, 2);
    await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-engaged', 'false');
    await expect(this.globalPlayer.loopPod).toHaveCSS('width', '39px');
    return this.readLoopActionVisualState();
  }

  async focusLoopAction(target = 'create') {
    const locator = target === 'cancel'
      ? this.globalPlayer.loopCancelButton
      : target === 'enter'
        ? this.globalPlayer.loopScissorsButton
        : this.globalPlayer.loopCreateButton;
    await locator.focus();
    await expect(locator).toBeFocused();
    return this.readLoopActionVisualState();
  }

  async readMainLoopVisualState() {
    return this.globalPlayer.readMainLoopVisualSnapshot();
  }

  async waitForMainLoopPlayheadAdvance(options = {}) {
    const { startSeconds, endSeconds } = await this.globalPlayer.readLoopEditorSnapshot();
    await this.globalPlayer.waitForPageCondition((expected) => {
      const timeline = document.querySelector(expected.timelineSelector);
      if (!(timeline instanceof HTMLInputElement)) return false;
      const currentValue = Number(timeline.value || 0);
      return currentValue >= expected.startSeconds && currentValue <= expected.endSeconds;
    }, {
      timeout: options.timeout || 60000,
    }, {
      timelineSelector: this.globalPlayer.timelineSelector,
      startSeconds,
      endSeconds,
    });
    const baseline = await this.readMainLoopVisualState();
    await this.globalPlayer.waitForPageCondition((expected) => {
      const timeline = document.querySelector(expected.timelineSelector);
      if (!(timeline instanceof HTMLInputElement)) return false;
      const currentValue = Number(timeline.value || 0);
      const inRange = currentValue >= expected.startSeconds && currentValue <= expected.endSeconds;
      const wrapped = currentValue < expected.baselineValue;
      const linearDelta = currentValue - expected.baselineValue;
      const circularDelta = (expected.endSeconds - expected.baselineValue) + (currentValue - expected.startSeconds);
      return inRange && (
        (!wrapped && linearDelta >= expected.minimumDelta)
        || (wrapped && circularDelta >= expected.minimumDelta)
      );
    }, {
      timeout: options.timeout || 60000,
    }, {
      timelineSelector: this.globalPlayer.timelineSelector,
      startSeconds,
      endSeconds,
      baselineValue: baseline.timeline.value,
      minimumDelta: Number(options.minimumDelta || 0.1),
    });
    const advanced = await this.readMainLoopVisualState();
    return {
      playheadAdvanced: true,
      timeline: advanced.timeline,
    };
  }

  async setLoopRange(range, options = {}) {
    const snapshot = await this.globalPlayer.readLoopEditorSnapshot();
    if (!(snapshot.duration > 0)) throw new Error('Expected a positive player duration before setting a loop range.');
    await this.dragLoopBoundary('start', Number(range.startSeconds) / snapshot.duration);
    await this.dragLoopBoundary('end', Number(range.endSeconds) / snapshot.duration);
    await this.globalPlayer.waitForPageCondition((expected) => {
      if (typeof state === 'undefined') return false;
      const start = Number(state.player?.loopStart) || 0;
      const end = Number(state.player?.loopEnd) || 0;
      return Math.abs(start - expected.startSeconds) < 0.01
        && Math.abs(end - expected.endSeconds) < 0.01;
    }, {
      timeout: options.timeout || 60000,
    }, {
      startSeconds: Number(range.startSeconds),
      endSeconds: Number(range.endSeconds),
    });
    const updatedSnapshot = await this.globalPlayer.readLoopEditorSnapshot();
    expect(updatedSnapshot.startLabel).toBe(String(range.startLabel));
    expect(updatedSnapshot.endLabel).toBe(String(range.endLabel));
    return updatedSnapshot;
  }

  async clickLoopRangeAt(targetFraction) {
    const fraction = Math.min(0.98, Math.max(0.02, Number(targetFraction)));
    const waveformBox = await this.globalPlayer.loopWaveform.boundingBox();
    if (!waveformBox) throw new Error('Expected a rendered bottom-player loop waveform.');
    const before = await this.globalPlayer.readLoopEditorSnapshot();
    const x = waveformBox.x + (waveformBox.width * fraction);
    const y = waveformBox.y + (waveformBox.height / 2);
    await this.globalPlayer.page.mouse.click(x, y);
    const targetSeconds = before.duration * fraction;
    await expect.poll(
      async () => (await this.globalPlayer.readPlaybackTiming()).currentTime,
      { timeout: 60000 },
    ).toBeCloseTo(targetSeconds, 0);
    return {
      targetFraction: fraction,
      targetSeconds,
      timing: await this.globalPlayer.readPlaybackTiming(),
      before,
      after: await this.globalPlayer.readLoopEditorSnapshot(),
    };
  }

  async dragLoopRangeFromTo(originFraction, targetFraction) {
    const origin = Math.min(0.98, Math.max(0.02, Number(originFraction)));
    const target = Math.min(0.98, Math.max(0.02, Number(targetFraction)));
    const waveformBox = await this.globalPlayer.loopWaveform.boundingBox();
    if (!waveformBox) throw new Error('Expected a rendered bottom-player loop waveform.');
    const y = waveformBox.y + (waveformBox.height / 2);
    await this.globalPlayer.page.mouse.move(waveformBox.x + (waveformBox.width * origin), y);
    await this.globalPlayer.page.mouse.down();
    await this.globalPlayer.page.mouse.move(
      waveformBox.x + (waveformBox.width * target),
      y,
      { steps: 8 },
    );
    const dragSnapshot = await this.globalPlayer.readLoopEditorSnapshot();
    await this.globalPlayer.page.mouse.up();
    return {
      originFraction: origin,
      targetFraction: target,
      dragSnapshot,
      after: await this.globalPlayer.readLoopEditorSnapshot(),
    };
  }

  async dragLoopBoundary(boundary, targetFraction) {
    if (!['start', 'end'].includes(boundary)) throw new Error('Loop boundary must be start or end.');
    const fraction = Math.min(0.98, Math.max(0.02, Number(targetFraction)));
    const waveformBox = await this.globalPlayer.loopWaveform.boundingBox();
    const handle = boundary === 'start' ? this.globalPlayer.loopStartHandle : this.globalPlayer.loopEndHandle;
    if (!waveformBox || !await handle.boundingBox()) {
      throw new Error('Expected rendered waveform and loop boundary handle bounds before dragging.');
    }
    await handle.hover();
    await this.globalPlayer.page.mouse.down();
    await this.globalPlayer.page.mouse.move(
      waveformBox.x + (waveformBox.width * fraction),
      waveformBox.y + (waveformBox.height / 2),
      { steps: 8 },
    );
    const dragSnapshot = await this.globalPlayer.readLoopEditorSnapshot();
    await this.globalPlayer.page.mouse.up();
    return {
      ...await this.globalPlayer.readLoopEditorSnapshot(),
      dragSnapshot,
    };
  }

  async enableStreamingLoopRange(range, options = {}) {
    await this.openLoopEditor(options);
    await this.setLoopRange(range, options);
    await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'editing');
    await this.globalPlayer.waitForPageCondition((expected) => {
      if (typeof state === 'undefined' || typeof getStreamingPlaybackSnapshot !== 'function') {
        return false;
      }
      const streaming = state.player?.streaming || {};
      return state.player?.loopActive === true
        && Math.abs((Number(state.player?.loopStart) || 0) - expected.startSeconds) < 0.01
        && Math.abs((Number(state.player?.loopEnd) || 0) - expected.endSeconds) < 0.01
        && Number(streaming.roles?.current?.streamId || 0) > 0
        && Number(streaming.roles?.continuity?.streamId || 0) > 0
        && !streaming.pendingPromotion;
    }, {
      timeout: options.timeout || 60000,
    }, {
      startSeconds: Number(range.startSeconds),
      endSeconds: Number(range.endSeconds),
    });
    return this.globalPlayer.readStreamingLoopIdentityCheckpoint();
  }

  async waitForStreamingLoopBoundary(previousCurrentStreamId, options = {}) {
    const priorStreamId = Number(previousCurrentStreamId);
    const expectedPromotedStreamId = Number(options.expectedPromotedStreamId);
    if (!(priorStreamId > 0)) {
      throw new RangeError(`Expected a positive current stream ID, received ${previousCurrentStreamId}.`);
    }
    await this.globalPlayer.waitForPageCondition((expected) => {
      if (typeof state === 'undefined' || typeof getStreamingPlaybackSnapshot !== 'function') {
        return false;
      }
      const snapshot = getStreamingPlaybackSnapshot();
      const streaming = state.player?.streaming || {};
      const currentStreamId = Number(streaming.roles?.current?.streamId || 0);
      const continuityStreamId = Number(streaming.roles?.continuity?.streamId || 0);
      return state.player?.loopActive === true
        && currentStreamId > 0
        && currentStreamId !== expected.priorStreamId
        && (!(expected.expectedPromotedStreamId > 0)
          || currentStreamId === expected.expectedPromotedStreamId)
        && continuityStreamId > 0
        && Boolean(snapshot.diagnostics?.boundaryCapture)
        && !streaming.pendingPromotion;
    }, {
      timeout: options.timeout || 60000,
    }, { priorStreamId, expectedPromotedStreamId });
    return this.globalPlayer.readStreamingLoopBoundaryCheckpoint();
  }

  async disableStreamingLoop(options = {}) {
    const requests = [];
    const observe = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') requests.push(request);
    };
    this.globalPlayer.page.on('request', observe);
    try {
      await this.globalPlayer.loopCancelButton.click();
      await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'idle');
      await expect(this.globalPlayer.loopScissorsButton).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopEditSurface).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopStartHandle).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopEndHandle).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopLegacyBoundaryTimes).toHaveCount(0);
      await expect(this.globalPlayer.timeline).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.timeline).toBeEnabled({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.timeline).toHaveCSS('pointer-events', 'auto');
      await expect(this.globalPlayer.time).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.time).toHaveText(/^\d+:\d{2}(?::\d{2})?\s*\/\s*\d+:\d{2}(?::\d{2})?$/);
      if (options.waitForStreaming !== false) {
        await this.globalPlayer.waitForPageCondition(() => {
          if (typeof state === 'undefined' || typeof getStreamingPlaybackSnapshot !== 'function') {
            return false;
          }
          const streaming = state.player?.streaming || {};
          return state.player?.loopActive === false
            && Number(streaming.roles?.current?.streamId || 0) > 0
            && Number(streaming.roles?.continuity?.streamId || 0) > 0
            && !streaming.pendingPromotion;
        }, { timeout: options.timeout || 60000 });
      }
    } finally {
      this.globalPlayer.page.off('request', observe);
    }
    return {
      requestCount: requests.length,
      exit: await this.globalPlayer.readStreamingLoopExitCheckpoint(),
    };
  }

  async cancelLoopEditorWithEscape(options = {}) {
    const requests = [];
    const observe = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') requests.push(request);
    };
    this.globalPlayer.page.on('request', observe);
    try {
      await this.globalPlayer.loopStartHandle.focus();
      await this.globalPlayer.page.keyboard.press('Escape');
      await expect(this.globalPlayer.loopAction).toHaveAttribute('data-loop-action-state', 'idle');
      await expect(this.globalPlayer.loopScissorsButton).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopEditSurface).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopStartHandle).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopEndHandle).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.loopLegacyBoundaryTimes).toHaveCount(0);
      await expect(this.globalPlayer.timeline).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.timeline).toBeEnabled({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.timeline).toHaveCSS('pointer-events', 'auto');
      await expect(this.globalPlayer.time).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(this.globalPlayer.time).toHaveText(/^\d+:\d{2}(?::\d{2})?\s*\/\s*\d+:\d{2}(?::\d{2})?$/);
    } finally {
      this.globalPlayer.page.off('request', observe);
    }
    return { requestCount: requests.length };
  }

  async waitForLoopNameDialog(options = {}) {
    const timeout = options.timeout || 60000;
    await expect(this.globalPlayer.loopNameModal).toBeVisible({ timeout });
    await expect(this.globalPlayer.loopNameInput).toBeVisible({ timeout });
    await expect(this.globalPlayer.loopNameInput).toBeFocused({ timeout });
    return {
      visible: true,
      focused: true,
      error: String(await this.globalPlayer.loopNameError.textContent() || '').trim(),
    };
  }

  async openLoopNameDialog(options = {}) {
    await this.globalPlayer.loopCreateButton.click();
    return this.waitForLoopNameDialog(options);
  }

  async openLoopNameDialogWithEnter(options = {}) {
    await this.globalPlayer.loopStartHandle.focus();
    await this.globalPlayer.loopStartHandle.press('Enter');
    return this.waitForLoopNameDialog(options);
  }

  async submitBlankLoopName(options = {}) {
    const timeout = options.timeout || 60000;
    await this.globalPlayer.loopNameInput.fill('');
    await this.globalPlayer.loopNameSubmitButton.click();
    await expect(this.globalPlayer.loopNameModal).toBeVisible({ timeout });
    await expect(this.globalPlayer.loopNameError).toBeVisible({ timeout });
    await expect(this.globalPlayer.loopNameError).not.toHaveText('', { timeout });
    await expect(this.globalPlayer.loopNameInput).toBeFocused({ timeout });
    return String(await this.globalPlayer.loopNameError.textContent() || '').trim();
  }

  async cancelLoopNameDialog(options = {}) {
    const requests = [];
    const observe = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') requests.push(request);
    };
    this.globalPlayer.page.on('request', observe);
    try {
      await this.globalPlayer.loopNameCancelButton.click();
      await expect(this.globalPlayer.loopNameModal).toBeHidden({ timeout: options.timeout || 60000 });
    } finally {
      this.globalPlayer.page.off('request', observe);
    }
    return { requestCount: requests.length };
  }

  async submitLoopName(name, options = {}) {
    const createRequests = [];
    const observeCreateRequest = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') {
        createRequests.push(request);
      }
    };
    this.globalPlayer.page.on('request', observeCreateRequest);
    const createResponsePromise = this.globalPlayer.page.waitForResponse((response) => (
      response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/loops/create'
    ), { timeout: options.timeout || 60000 });
    await this.globalPlayer.loopNameInput.fill(String(name));
    if (options.submitWithEnter) {
      await this.globalPlayer.loopNameInput.press('Enter');
    } else {
      await this.globalPlayer.loopNameSubmitButton.click();
    }
    try {
      const response = await createResponsePromise;
      if (!response.ok()) {
        throw new Error(`Loop create request failed with ${response.status()}.`);
      }
      await expect(this.globalPlayer.loopNameModal).toBeHidden({ timeout: options.timeout || 60000 });
      return {
        requestCount: createRequests.length,
        payload: await response.json(),
      };
    } finally {
      this.globalPlayer.page.off('request', observeCreateRequest);
    }
  }

  async saveLoopWithName(name, options = {}) {
    await this.openLoopNameDialog(options);
    return this.submitLoopName(name, options);
  }
}
