import { BasePage } from './basePage.js';

export async function readDecodedPlayerCoverCheckpoint(button) {
  if (!(button instanceof HTMLButtonElement) || button.hidden) {
    throw new Error('Player cover button is not visible for artwork decoding.');
  }

  const bounds = button.getBoundingClientRect();
  if (!(bounds.width > 0 && bounds.height > 0)) {
    throw new Error('Player cover button has no rendered size for artwork decoding.');
  }

  const backgroundImage = String(getComputedStyle(button).backgroundImage || '');
  const sourceMatch = /^url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)$/.exec(backgroundImage.trim());
  const source = String(sourceMatch?.[1] ?? sourceMatch?.[2] ?? sourceMatch?.[3] ?? '').trim();
  if (!source) {
    throw new Error('Player cover background does not contain an artwork URL.');
  }

  const sourceUrl = new URL(source, document.baseURI).href;
  const image = new Image();
  image.src = sourceUrl;
  await image.decode();
  if (!(image.complete && image.naturalWidth > 0 && image.naturalHeight > 0)) {
    throw new Error('Player cover artwork decoded without positive intrinsic dimensions.');
  }

  return {
    hidden: button.hidden,
    backgroundImage,
    sourceUrl,
    width: bounds.width,
    height: bounds.height,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  };
}

export class GlobalPlayer extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.appKeyboardSurface = page.locator('body');
    this.player = page.locator('.global-player');
    this.mainArea = page.locator('.player-main');
    this.coverButton = page.locator(this.coverButtonSelector);
    this.playButton = page.locator('#player-play');
    this.title = page.locator(this.titleSelector);
    this.ownershipSurface = this.title;
    this.albumLink = page.locator('#player-album-link');
    this.timeline = page.locator('#player-timeline');
    this.waveformCanvas = page.locator(this.waveformCanvasSelector);
    this.time = page.locator('#player-time');
    this.readinessErrorToasts = page.locator('#toast-layer .toast.is-error.is-visible').filter({
      hasText: /readiness/i,
    });
    this.loopAction = page.locator('[data-loop-action-owner="global-player"]');
    this.loopPod = this.loopAction.locator('[data-loop-action-pod]');
    this.loopDivider = this.loopAction.locator('[data-loop-action-divider]');
    this.loopScissorsButton = this.loopAction.getByRole('button', { name: 'Create a loop', exact: true });
    this.loopCreateButton = this.loopAction.getByRole('button', { name: 'Create loop', exact: true });
    this.loopCancelButton = this.loopAction.getByRole('button', { name: 'Cancel loop creation', exact: true });
    this.loopRangeOwner = page.locator('[data-loop-range-owner="global-player"]');
    this.loopEditSurface = this.loopRangeOwner.locator('[data-loop-range-surface]');
    this.loopWaveform = this.loopRangeOwner.locator('canvas[data-loop-range-waveform]');
    this.loopSelection = this.loopRangeOwner.locator('#player-loop-region');
    this.loopStartHandle = this.loopRangeOwner.getByRole('slider', { name: 'Loop start', exact: true });
    this.loopEndHandle = this.loopRangeOwner.getByRole('slider', { name: 'Loop end', exact: true });
    this.loopLegacyBoundaryTimes = this.loopRangeOwner.locator('[data-loop-range-time]');
    this.legacyLoopButton = page.locator('#player-loop-button');
    this.legacyLoopPopup = page.locator('#loop-popup');
    this.loopNameModal = page.locator('#loop-name-modal');
    this.loopNameForm = page.locator('#loop-name-form');
    this.loopNameInput = page.locator('#loop-name-input');
    this.loopNameError = page.locator('#loop-name-error');
    this.loopNameCancelButton = page.locator('#loop-name-cancel');
    this.loopNameSubmitButton = page.locator('#loop-name-submit');
    this.foregroundSurfaces = Object.freeze({
      albumDetails: page.locator('#track-modal'),
      notifications: page.locator('#cover-lookup-drawer'),
      settings: page.locator('#utility-modal'),
    });
  }

  get titleSelector() {
    return '#player-title';
  }

  get coverButtonSelector() {
    return '#player-cover-button';
  }

  get timelineSelector() {
    return '#player-timeline';
  }

  get waveformCanvasSelector() {
    return '#player-waveform-canvas';
  }

  async waitForDecodedCover(options = {}) {
    await this.waitForPageCondition((selector) => {
      const button = document.querySelector(selector);
      if (!(button instanceof HTMLButtonElement) || button.hidden) return false;
      const bounds = button.getBoundingClientRect();
      const backgroundImage = String(getComputedStyle(button).backgroundImage || '');
      return bounds.width > 0
        && bounds.height > 0
        && /^url\((?:"[^"]+"|'[^']+'|[^)]+)\)$/.test(backgroundImage);
    }, {
      timeout: options.timeout || 15000,
    }, this.coverButtonSelector);
    // parity-check: allow-read-only-measurement-evaluate -- independently decode the production player-cover URL
    return this.coverButton.evaluate(readDecodedPlayerCoverCheckpoint);
  }

  async readSeekCompletionCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- production rendered-seek completion diagnostics
    return this.page.evaluate((timelineSelector) => {
      const snapshot = getStreamingPlaybackSnapshot();
      const playback = getPlayerPlaybackSnapshot();
      const timeline = document.querySelector(timelineSelector);
      return {
        completedAtMs: performance.now(),
        generation: Number(snapshot.generation || 0),
        firstFrameAtMs: Number(snapshot.diagnostics?.firstFrameAtMs || 0),
        seekRequestedAtMs: Number(snapshot.diagnostics?.seekRequestedAtMs || 0),
        seekCommittedAtMs: Number(snapshot.diagnostics?.seekCommittedAtMs || 0),
        seekSilentFrames: Number(snapshot.diagnostics?.seekSilentFrames || 0),
        seekCapture: snapshot.diagnostics?.seekCapture || null,
        duration: Number(playback.duration || 0),
        timelineValue: Number(timeline?.value || 0),
      };
    }, this.timelineSelector);
  }

  async readSeekBaselineCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- browser-monotonic visible seek timing
    return this.page.evaluate(() => {
      const snapshot = typeof getStreamingPlaybackSnapshot === 'function'
        ? getStreamingPlaybackSnapshot()
        : null;
      return {
        generation: Number(snapshot?.generation || 0),
        firstFrameAtMs: Number(snapshot?.diagnostics?.firstFrameAtMs || 0),
        seekCommittedAtMs: Number(snapshot?.diagnostics?.seekCommittedAtMs || 0),
        continuityStreamId: Number(state.player?.streaming?.roles?.continuity?.streamId || 0),
      };
    });
  }

  async readReloadPlaybackCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- restored role identity and browser autoplay outcome
    return this.page.evaluate(() => {
      const playback = getPlayerPlaybackSnapshot();
      const streaming = getStreamingPlaybackSnapshot();
      const role = state.player?.streaming?.roles?.current || null;
      return {
        paused: Boolean(playback.paused),
        currentTime: Number(playback.currentTime) || 0,
        path: String(role?.track?.path || ''),
        generation: Number(role?.generation || 0),
        streamId: Number(role?.streamId || 0),
        mode: String(streaming.mode || ''),
        contextState: String(streaming.diagnostics?.contextState || ''),
        renderedFrame: Number(streaming.renderedFrame || 0),
      };
    });
  }

  async readRenderedWaveformCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- visible production waveform pixels and compact payload
    return this.waveformCanvas.evaluate((canvas) => {
      const peaks = state.player.waveform.compactPeaks.data;
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let nonTransparentPixels = 0;
      let nonPlayheadPixels = 0;
      const playback = getStreamingPlaybackSnapshot();
      const progress = Number(playback.duration) > 0
        ? Math.max(0, Math.min(1, Number(playback.currentTime || 0) / Number(playback.duration)))
        : 0;
      const playheadX = Math.round(progress * canvas.width);
      for (let pixel = 0; pixel < pixels.length / 4; pixel += 1) {
        if (pixels[(pixel * 4) + 3] > 0) {
          nonTransparentPixels += 1;
          if (Math.abs((pixel % canvas.width) - playheadX) > 4) nonPlayheadPixels += 1;
        }
      }
      return {
        firstFrameAtMs: Number(playback.diagnostics?.firstFrameAtMs || 0),
        leftPeaks: [...peaks.left],
        leftBins: peaks.left.length,
        rightBins: peaks.right.length,
        nonPlayheadPixels,
        nonTransparentPixels,
        path: String(state.player.waveform.compactPeaks.path || ''),
        renderedAtEpochMs: performance.timeOrigin + performance.now(),
        renderedAtMs: performance.now(),
        rightPeaks: [...peaks.right],
      };
    });
  }

  async readStreamingLoopIdentityCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- establish the production loop-boundary stream identity
    return this.page.evaluate(() => {
      const snapshot = getStreamingPlaybackSnapshot();
      const streaming = state.player?.streaming || {};
      return {
        generation: Number(snapshot.generation || 0),
        currentStreamId: Number(streaming.roles?.current?.streamId || 0),
        continuityStreamId: Number(streaming.roles?.continuity?.streamId || 0),
        underruns: Number(snapshot.diagnostics?.underruns || 0),
      };
    });
  }

  async readStreamingLoopBoundaryCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- measure the production processor's bounded loop-boundary capture
    return this.page.evaluate(() => {
      const snapshot = getStreamingPlaybackSnapshot();
      const streaming = state.player?.streaming || {};
      const capture = snapshot.diagnostics?.boundaryCapture || {};
      const discontinuities = ['left', 'right'].map((channel) => {
        const outgoing = Array.from(capture.outgoing?.[channel] || []);
        const incoming = Array.from(capture.incoming?.[channel] || []);
        const outgoingFrames = Number(capture.outgoing?.frames || 0);
        if (!(outgoingFrames > 0) || incoming.length === 0) return Number.POSITIVE_INFINITY;
        return Math.abs(Number(outgoing[outgoingFrames - 1]) - Number(incoming[0]));
      });
      return {
        generation: Number(snapshot.generation || 0),
        currentStreamId: Number(streaming.roles?.current?.streamId || 0),
        continuityStreamId: Number(streaming.roles?.continuity?.streamId || 0),
        activeRoles: Array.from(snapshot.diagnostics?.activeRoles || []),
        outgoingFrames: Number(capture.outgoing?.frames || 0),
        incomingFrames: Number(capture.incoming?.frames || 0),
        maxSampleDiscontinuity: Math.max(...discontinuities),
        underruns: Number(snapshot.diagnostics?.underruns || 0),
      };
    });
  }

  async readStreamingLoopExitCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- verify queued continuity restored after the visible loop exit
    return this.page.evaluate(() => {
      const snapshot = getStreamingPlaybackSnapshot();
      const streaming = state.player?.streaming || {};
      return {
        currentPath: String(streaming.roles?.current?.track?.path || ''),
        continuityPath: String(streaming.roles?.continuity?.track?.path || ''),
        underruns: Number(snapshot.diagnostics?.underruns || 0),
      };
    });
  }

  async readLoopEditorSnapshot() {
    const [
      playerBounds,
      mainAreaBounds,
      waveformBounds,
      selectionBounds,
      startHandleBounds,
      endHandleBounds,
      titleBounds,
      albumBounds,
      timeBounds,
    ] = await Promise.all([
      this.player.boundingBox(),
      this.mainArea.boundingBox(),
      this.loopWaveform.boundingBox(),
      this.loopSelection.boundingBox(),
      this.loopStartHandle.boundingBox(),
      this.loopEndHandle.boundingBox(),
      this.title.boundingBox(),
      this.albumLink.boundingBox(),
      this.time.boundingBox(),
    ]);
    if (!playerBounds || !mainAreaBounds || !waveformBounds || !selectionBounds
        || !startHandleBounds || !endHandleBounds || !titleBounds || !timeBounds) {
      throw new Error('Expected the bottom-player loop range, selection, metadata, and both handles to have rendered bounds.');
    }
    const fractionForHandle = (bounds) => (
      ((bounds.x + (bounds.width / 2)) - waveformBounds.x) / waveformBounds.width
    );
    const fractionForEdge = (edge) => ((edge - waveformBounds.x) / waveformBounds.width);
    const startHandleCenter = startHandleBounds.x + (startHandleBounds.width / 2);
    const endHandleCenter = endHandleBounds.x + (endHandleBounds.width / 2);
    const selectionLeft = selectionBounds.x;
    const selectionRight = selectionBounds.x + selectionBounds.width;
    const metadataBottom = Math.max(
      titleBounds.y + titleBounds.height,
      albumBounds ? albumBounds.y + albumBounds.height : 0,
      timeBounds.y + timeBounds.height,
    );
    // parity-check: allow-read-only-measurement-evaluate -- inspect rendered loop-edit cursor contracts only
    const cursors = await this.loopEditSurface.evaluate((surface) => {
      const selection = surface.querySelector('.loop-range-selection');
      const start = surface.querySelector('[data-loop-range-handle="start"]');
      const end = surface.querySelector('[data-loop-range-handle="end"]');
      return {
        surface: getComputedStyle(surface).cursor,
        selection: selection ? getComputedStyle(selection).cursor : '',
        startHandle: start ? getComputedStyle(start).cursor : '',
        endHandle: end ? getComputedStyle(end).cursor : '',
      };
    });
    const timeLabel = String(await this.time.textContent() || '').trim();
    const [startLabel = '', endLabel = ''] = timeLabel.split(/\s+-\s+/, 2);
    return {
      playerBounds,
      mainAreaBounds,
      waveformBounds,
      selectionBounds,
      startHandleBounds,
      endHandleBounds,
      startHandleFraction: fractionForHandle(startHandleBounds),
      endHandleFraction: fractionForHandle(endHandleBounds),
      selectionLeftFraction: fractionForEdge(selectionLeft),
      selectionRightFraction: fractionForEdge(selectionRight),
      selectionStartErrorPixels: Math.abs(selectionLeft - startHandleCenter),
      selectionEndErrorPixels: Math.abs(selectionRight - endHandleCenter),
      cursors,
      playerHeight: playerBounds.height,
      waveformHeight: waveformBounds.height,
      metadataWaveformGap: waveformBounds.y - metadataBottom,
      timeWaveformOverlap: timeBounds.y < waveformBounds.y + waveformBounds.height
        && timeBounds.y + timeBounds.height > waveformBounds.y,
      timeLabel,
      timeSlotCount: await this.player.locator('#player-time').count(),
      legacyBoundaryTimeCount: await this.loopLegacyBoundaryTimes.count(),
      startLabel,
      endLabel,
      startSeconds: this.parseLoopBoundaryLabel(startLabel),
      endSeconds: this.parseLoopBoundaryLabel(endLabel),
      duration: Number(await this.loopStartHandle.getAttribute('aria-valuemax')),
      startValueNow: Number(await this.loopStartHandle.getAttribute('aria-valuenow')),
      endValueNow: Number(await this.loopEndHandle.getAttribute('aria-valuenow')),
    };
  }

  async readLoopActionVisualSnapshot() {
    const [
      rootBounds,
      podBounds,
      playerBounds,
      mainAreaBounds,
      waveformBounds,
      coverBounds,
      playBounds,
      timelineSurfaceBounds,
      titleBounds,
    ] = await Promise.all([
      this.loopAction.boundingBox(),
      this.loopPod.boundingBox(),
      this.player.boundingBox(),
      this.mainArea.boundingBox(),
      this.waveformCanvas.boundingBox(),
      this.coverButton.boundingBox(),
      this.playButton.boundingBox(),
      this.timeline.boundingBox(),
      this.title.boundingBox(),
    ]);
    if (!rootBounds || !podBounds || !playerBounds || !mainAreaBounds || !playBounds
        || !timelineSurfaceBounds || !titleBounds) {
      throw new Error('Expected rendered bottom-player loop action geometry.');
    }
    // parity-check: allow-read-only-measurement-evaluate -- inspect rendered shared-loop visual state only
    const styles = await this.loopAction.evaluate((root) => {
      const pod = root.querySelector('[data-loop-action-pod]');
      const enter = root.querySelector('[data-loop-action="enter"]');
      const create = root.querySelector('[data-loop-action="create"]');
      const cancel = root.querySelector('[data-loop-action="cancel"]');
      const divider = root.querySelector('[data-loop-action-divider]');
      const read = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        return {
          color: style.color,
          cursor: style.cursor,
          display: style.display,
          opacity: Number(style.opacity),
          textShadow: style.textShadow,
          visibility: style.visibility,
        };
      };
      return {
        state: root.getAttribute('data-loop-action-state'),
        engaged: root.getAttribute('data-loop-action-engaged'),
        ariaBusy: root.getAttribute('aria-busy'),
        pod: read(pod),
        enter: read(enter),
        create: read(create),
        cancel: read(cancel),
        divider: read(divider),
        enterDisabled: enter instanceof HTMLButtonElement && enter.disabled,
        enterTitle: enter?.getAttribute('title') || '',
      };
    });
    return {
      rootBounds,
      podBounds,
      playerBounds,
      mainAreaBounds,
      waveformBounds,
      coverBounds,
      playBounds,
      timelineSurfaceBounds,
      titleBounds,
      titleTopGap: titleBounds.y - playerBounds.y,
      coverCenterY: coverBounds ? coverBounds.y + (coverBounds.height / 2) : null,
      playCenterY: playBounds.y + (playBounds.height / 2),
      timelineCenterY: timelineSurfaceBounds.y + (timelineSurfaceBounds.height / 2),
      mainLeftGapFromPlay: mainAreaBounds.x - (playBounds.x + playBounds.width),
      styles,
    };
  }

  async readMainLoopVisualSnapshot() {
    const [waveformBounds, selectionBounds, startHandleBounds, endHandleBounds] = await Promise.all([
      this.waveformCanvas.boundingBox(),
      this.loopSelection.boundingBox(),
      this.loopStartHandle.boundingBox(),
      this.loopEndHandle.boundingBox(),
    ]);
    if (!waveformBounds || !selectionBounds || !startHandleBounds || !endHandleBounds) {
      throw new Error('Expected rendered bottom-player waveform, selection, and handles.');
    }
    // parity-check: allow-read-only-measurement-evaluate -- inspect channel occupancy and the visible native playhead
    const canvas = await this.waveformCanvas.evaluate((element) => {
      const context = element.getContext('2d');
      const pixels = context?.getImageData(0, 0, element.width, element.height).data || [];
      const midpoint = Math.floor(element.height / 2);
      let upperPixels = 0;
      let lowerPixels = 0;
      for (let y = 0; y < element.height; y += 1) {
        for (let x = 0; x < element.width; x += 1) {
          if (pixels[((y * element.width + x) * 4) + 3] === 0) continue;
          if (y < midpoint) upperPixels += 1;
          if (y > midpoint) lowerPixels += 1;
        }
      }
      return { upperPixels, lowerPixels };
    });
    // parity-check: allow-read-only-measurement-evaluate -- inspect the visible native playhead only
    const timeline = await this.timeline.evaluate((element) => ({
      opacity: Number(getComputedStyle(element).opacity),
      value: Number(element.value || 0),
      visible: !element.hidden && getComputedStyle(element).visibility !== 'hidden',
    }));
    return {
      canvas,
      timeline,
      waveformBounds,
      selectionBounds,
      startHandleBounds,
      endHandleBounds,
      selectionTopOvershoot: waveformBounds.y - selectionBounds.y,
      selectionBottomOvershoot: (selectionBounds.y + selectionBounds.height)
        - (waveformBounds.y + waveformBounds.height),
    };
  }

  parseLoopBoundaryLabel(label) {
    const match = /^(?:(\d+):)?(\d+):([0-5]\d)\.(\d{3})$/.exec(String(label || '').trim());
    if (!match) return Number.NaN;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    if (match[1] !== undefined && minutes >= 60) return Number.NaN;
    return (hours * 3600) + (minutes * 60) + Number(match[3]) + (Number(match[4]) / 1000);
  }

  foregroundSurface(surfaceName) {
    const surface = this.foregroundSurfaces[surfaceName];
    if (!surface) {
      throw new Error(`Unknown foreground player surface: ${JSON.stringify(surfaceName)}.`);
    }
    return surface;
  }

  async readForegroundLaneCheckpoint(surfaceName) {
    const surface = this.foregroundSurface(surfaceName);
    const [playerRectangle, surfaceRectangle] = await Promise.all([
      this.player.boundingBox(),
      surface.boundingBox(),
    ]);
    const viewport = this.page.viewportSize();
    if (!playerRectangle || !surfaceRectangle || !viewport) {
      throw new Error(`Cannot measure the persistent player lane for ${surfaceName}.`);
    }
    return {
      viewport,
      player: {
        top: playerRectangle.y,
        bottom: playerRectangle.y + playerRectangle.height,
        height: playerRectangle.height,
      },
      surface: {
        top: surfaceRectangle.y,
        bottom: surfaceRectangle.y + surfaceRectangle.height,
        height: surfaceRectangle.height,
      },
    };
  }

  async readPlaybackSummary() {
    // parity-check: allow-read-only-measurement-evaluate -- observe the production playback snapshot used by the UI
    const playback = await this.page.evaluate(() => {
      if (typeof getPlayerPlaybackSnapshot !== 'function') {
        throw new Error('Production playback snapshot is unavailable.');
      }
      return getPlayerPlaybackSnapshot();
    });
    return {
      title: String(await this.title.textContent() || '').trim(),
      playbackControl: String(await this.playButton.getAttribute('aria-label') || '').trim(),
      paused: Boolean(playback.paused),
    };
  }

  async readPlaybackTiming() {
    // parity-check: allow-read-only-measurement-evaluate -- read the production player snapshot for a visible timeline action
    return this.page.evaluate(() => {
      if (typeof getPlayerPlaybackSnapshot !== 'function') {
        throw new Error('Production playback snapshot is unavailable.');
      }
      const playback = getPlayerPlaybackSnapshot();
      return {
        currentTime: Number(playback.currentTime || 0),
        duration: Number(playback.duration || 0),
      };
    });
  }

  async readWallClockTimeMs() {
    // parity-check: allow-read-only-measurement-evaluate -- read the installed browser clock without changing app state
    return this.page.evaluate(() => Date.now());
  }
}
