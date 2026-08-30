import { BasePage } from './basePage.js';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class UtilityLoopEntryCard extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.entries = page.locator('[data-utility-loop-entry]');
    this.detailEntries = page.locator('#utility-problematic-detail [data-utility-loop-entry]');
    this.detailHeader = page.locator('.utility-loop-detail-header');
    this.detailTitle = this.detailHeader.locator('.utility-detail-title');
    this.detailMetas = this.detailHeader.locator('.utility-detail-meta');
    this.playButtons = page.locator('[data-loop-play]');
    this.repeatButtons = page.locator('[data-toggle-loop-repeat]');
    this.timelines = page.locator('[data-loop-timeline]');
    this.deleteConfirmOverlay = page.locator('#loop-delete-confirm-modal');
    this.deleteConfirmDialog = this.deleteConfirmOverlay.getByRole('dialog', {
      name: 'Delete saved loop',
      exact: true,
    });
    this.deleteConfirmText = this.deleteConfirmDialog.locator('#loop-delete-confirm-text');
    this.deleteConfirmNo = this.deleteConfirmDialog.getByRole('button', { name: 'No', exact: true });
    this.deleteConfirmYes = this.deleteConfirmDialog.getByRole('button', { name: 'Yes', exact: true });
  }

  entryByName(name) {
    const exactName = new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`);
    return this.entries.filter({
      has: this.page.locator('.utility-detail-title').filter({ hasText: exactName }),
    });
  }

  playButtonForEntry(entry) {
    return entry.locator('[data-loop-play]');
  }

  audioForEntry(entry) {
    return entry.locator('[data-loop-audio]');
  }

  repeatButtonForEntry(entry) {
    return entry.locator('[data-toggle-loop-repeat]');
  }

  async repeatPressedForEntry(entry) {
    return await this.repeatButtonForEntry(entry).getAttribute('aria-pressed') === 'true';
  }

  speedValueButtonForEntry(entry) {
    return entry.locator('[data-loop-speed-value-button]');
  }

  deleteButtonForEntry(entry) {
    return entry.locator('[data-delete-saved-loop]');
  }

  async readDeleteConfirmationStack() {
    // parity-check: allow-read-only-measurement-evaluate -- measure modal stacking and hit-testing only
    return this.deleteConfirmDialog.evaluate((dialog) => {
      const overlay = document.getElementById('loop-delete-confirm-modal');
      const utility = document.getElementById('utility-modal');
      const bounds = dialog.getBoundingClientRect();
      const centerX = bounds.left + (bounds.width / 2);
      const centerY = bounds.top + (bounds.height / 2);
      const topElement = document.elementsFromPoint(centerX, centerY)[0] || null;
      return {
        deleteZIndex: Number(getComputedStyle(overlay).zIndex) || 0,
        utilityZIndex: Number(getComputedStyle(utility).zIndex) || 0,
        deleteOwnsTopElement: Boolean(topElement?.closest?.('#loop-delete-confirm-modal')),
      };
    });
  }

  async selectDeleteConfirmationTextAndReleaseOnBackdrop() {
    const [textBounds, dialogBounds, overlayBounds] = await Promise.all([
      this.deleteConfirmText.boundingBox(),
      this.deleteConfirmDialog.boundingBox(),
      this.deleteConfirmOverlay.boundingBox(),
    ]);
    if (!textBounds || !dialogBounds || !overlayBounds) {
      throw new Error('Expected visible delete-confirmation text, dialog, and backdrop bounds.');
    }
    const startX = textBounds.x + Math.max(2, textBounds.width - 4);
    const startY = textBounds.y + (textBounds.height / 2);
    const endX = Math.max(overlayBounds.x + 4, dialogBounds.x - 12);
    const endY = dialogBounds.y + (dialogBounds.height / 2);
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    await this.page.mouse.move(endX, endY, { steps: 10 });
    await this.page.mouse.up();
  }

  speedControlForEntry(entry) {
    return entry.locator('[data-loop-speed-control]');
  }

  speedOptionForEntry(entry, speed) {
    return entry.locator('[data-loop-speed-option="' + Number(speed).toFixed(2) + '"]');
  }

  pitchStepButtonForEntry(entry, step) {
    return entry.locator('[data-loop-pitch-step="' + Number(step) + '"]');
  }

  pitchValueForEntry(entry) {
    return entry.locator('[data-loop-pitch-value]');
  }

  loopActionForEntry(entry) {
    return entry.locator('[data-loop-action-owner]');
  }

  loopPodForEntry(entry) {
    return this.loopActionForEntry(entry).locator('[data-loop-action-pod]');
  }

  loopDividerForEntry(entry) {
    return this.loopActionForEntry(entry).locator('[data-loop-action-divider]');
  }

  loopScissorsButtonForEntry(entry) {
    return this.loopActionForEntry(entry).getByRole('button', { name: 'Create another loop', exact: true });
  }

  loopCreateButtonForEntry(entry) {
    return this.loopActionForEntry(entry).getByRole('button', { name: 'Create loop', exact: true });
  }

  loopCancelButtonForEntry(entry) {
    return this.loopActionForEntry(entry).getByRole('button', { name: 'Cancel loop creation', exact: true });
  }

  savedLoopMainSurfaceForEntry(entry) {
    return entry.locator('[data-saved-loop-main-surface]');
  }

  savedLoopEditRangeForEntry(entry, loopId = '') {
    return entry.locator(loopId
      ? '[data-loop-range-owner="saved-loop-' + String(loopId) + '"]'
      : '[data-loop-range-owner]');
  }

  savedLoopWaveformForEntry(entry, loopId = '') {
    return entry.locator(loopId
      ? '[data-loop-range-owner="saved-loop-' + String(loopId) + '"] canvas[data-loop-range-waveform]'
      : 'canvas[data-loop-range-waveform]');
  }

  savedLoopTimeForEntry(entry) {
    return entry.locator('[data-loop-time]');
  }

  savedLoopBoundaryHandleForEntry(entry, boundary, loopId = '') {
    const editor = this.savedLoopEditRangeForEntry(entry, loopId);
    return editor.getByRole('slider', {
      name: boundary === 'start' ? 'Loop start' : 'Loop end',
      exact: true,
    });
  }

  savedLoopSelectionForEntry(entry, loopId = '') {
    return this.savedLoopEditRangeForEntry(entry, loopId).locator('.loop-range-selection');
  }

  ordinaryTimelineForEntry(entry) {
    return entry.locator('[data-loop-timeline]');
  }

  ordinaryTimeForEntry(entry) {
    return this.savedLoopTimeForEntry(entry);
  }

  topRowForEntry(entry) {
    return entry.locator('[data-loop-player-top-row]');
  }

  pitchControlForEntry(entry) {
    return entry.locator('[data-loop-pitch-control]');
  }

  timelineWrapForEntry(entry) {
    return entry.locator('.utility-loop-timeline-wrap');
  }

  utilityMainForEntry(entry) {
    return entry.locator('.utility-loop-main');
  }

  async readSavedLoopEditorSnapshot(entry) {
    const loopId = String(await entry.getAttribute('data-utility-loop-entry') || '');
    const editor = this.savedLoopEditRangeForEntry(entry, loopId);
    const waveform = this.savedLoopWaveformForEntry(entry, loopId);
    const time = this.savedLoopTimeForEntry(entry);
    const startHandle = this.savedLoopBoundaryHandleForEntry(entry, 'start', loopId);
    const endHandle = this.savedLoopBoundaryHandleForEntry(entry, 'end', loopId);
    const editControl = this.loopActionForEntry(entry);
    const counts = {
      editor: await editor.count(),
      waveform: await waveform.count(),
      timeSlot: await time.count(),
      legacyBoundaryTimes: await entry.locator('[data-loop-range-time]').count(),
      startHandle: await startHandle.count(),
      endHandle: await endHandle.count(),
    };
    const visibility = {
      editor: counts.editor === 1 && await editor.isVisible(),
      waveform: counts.waveform === 1 && await waveform.isVisible(),
      timeSlot: counts.timeSlot === 1 && await time.isVisible(),
      startHandle: counts.startHandle === 1 && await startHandle.isVisible(),
      endHandle: counts.endHandle === 1 && await endHandle.isVisible(),
    };
    if (!visibility.editor) {
      return { counts, visibility };
    }

    const [
      waveformBox,
      selectionBox,
      startHandleBox,
      endHandleBox,
      mainBox,
      timeBox,
      pitchBox,
      editControlBox,
    ] = await Promise.all([
      waveform.boundingBox(),
      this.savedLoopSelectionForEntry(entry, loopId).boundingBox(),
      startHandle.boundingBox(),
      endHandle.boundingBox(),
      this.utilityMainForEntry(entry).boundingBox(),
      time.boundingBox(),
      this.pitchControlForEntry(entry).boundingBox(),
      editControl.boundingBox(),
    ]);
    if (!waveformBox || !selectionBox || !startHandleBox || !endHandleBox || !mainBox || !timeBox || !editControlBox) {
      throw new Error('Expected the saved-loop waveform, selection, timestamp, and both boundary handles to have rendered bounds.');
    }
    // parity-check: allow-read-only-measurement-evaluate -- read real media duration and rendered waveform pixels
    const [duration, waveformPixels] = await Promise.all([
      this.audioForEntry(entry).evaluate((audio) => Number(audio.duration || 0)),
      // parity-check: allow-read-only-measurement-evaluate -- read rendered waveform pixels only
      waveform.evaluate((canvas) => {
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data || [];
        let nonTransparent = 0;
        for (let index = 3; index < pixels.length; index += 4) {
          if (pixels[index] > 0) nonTransparent += 1;
        }
        return nonTransparent;
      }),
    ]);
    const fractionForHandle = (box) => (
      ((box.x + (box.width / 2)) - waveformBox.x) / waveformBox.width
    );
    const fractionForEdge = (edge) => ((edge - waveformBox.x) / waveformBox.width);
    const startHandleCenter = startHandleBox.x + (startHandleBox.width / 2);
    const startHandleCenterY = startHandleBox.y + (startHandleBox.height / 2);
    const endHandleCenter = endHandleBox.x + (endHandleBox.width / 2);
    const selectionLeft = selectionBox.x;
    const selectionRight = selectionBox.x + selectionBox.width;
    // parity-check: allow-read-only-measurement-evaluate -- inspect rendered saved-loop cursor and visibility contracts only
    const styles = await editor.evaluate((surface) => {
      const selection = surface.querySelector('.loop-range-selection');
      const start = surface.querySelector('[data-loop-range-handle="start"]');
      const end = surface.querySelector('[data-loop-range-handle="end"]');
      return {
        surfaceCursor: getComputedStyle(surface).cursor,
        selectionCursor: selection ? getComputedStyle(selection).cursor : '',
        startHandleCursor: start ? getComputedStyle(start).cursor : '',
        endHandleCursor: end ? getComputedStyle(end).cursor : '',
      };
    });
    const timeLabel = String(await time.textContent() || '').trim();
    const [startLabel = '', endLabel = ''] = timeLabel.split(/\s+-\s+/, 2);
    const overlapLeft = Math.max(startHandleBox.x, editControlBox.x);
    const overlapRight = Math.min(
      startHandleBox.x + startHandleBox.width,
      editControlBox.x + editControlBox.width,
    );
    const overlapTop = Math.max(startHandleBox.y, editControlBox.y);
    const overlapBottom = Math.min(
      startHandleBox.y + startHandleBox.height,
      editControlBox.y + editControlBox.height,
    );
    const startHandleOverlapsEditControl = overlapRight > overlapLeft && overlapBottom > overlapTop;
    const overlapProbe = {
      x: overlapLeft + ((overlapRight - overlapLeft) / 2),
      y: overlapTop + ((overlapBottom - overlapTop) / 2),
    };
    // parity-check: allow-read-only-measurement-evaluate -- inspect the browser's real paint order at the overlap point
    const editControlPaintsAboveStartHandle = await this.page.evaluate(({ x, y }) => {
      const stack = document.elementsFromPoint(x, y);
      const editControlIndex = stack.findIndex((element) => element.closest?.('[data-loop-action-owner]'));
      const handleIndex = stack.findIndex((element) => element.closest?.('[data-loop-range-handle="start"]'));
      return editControlIndex >= 0 && handleIndex >= 0 && editControlIndex < handleIndex;
    }, overlapProbe);
    return {
      counts,
      visibility,
      duration,
      timeLabel,
      startLabel,
      endLabel,
      startValueNow: Number(await startHandle.getAttribute('aria-valuenow')),
      endValueNow: Number(await endHandle.getAttribute('aria-valuenow')),
      startHandleFraction: fractionForHandle(startHandleBox),
      endHandleFraction: fractionForHandle(endHandleBox),
      selectionLeftFraction: fractionForEdge(selectionLeft),
      selectionRightFraction: fractionForEdge(selectionRight),
      selectionStartErrorPixels: Math.abs(selectionLeft - startHandleCenter),
      selectionEndErrorPixels: Math.abs(selectionRight - endHandleCenter),
      waveformPixels,
      waveformBounds: waveformBox,
      selectionBounds: selectionBox,
      startHandleBounds: startHandleBox,
      endHandleBounds: endHandleBox,
      startHandleOverlapsEditControl,
      editControlPaintsAboveStartHandle,
      cursors: styles,
      pitchVisible: Boolean(pitchBox),
      timestampVisible: visibility.timeSlot,
      timeWaveformOverlap: timeBox.y < waveformBox.y + waveformBox.height
        && timeBox.y + timeBox.height > waveformBox.y,
      playerHeight: mainBox.height,
      waveformHeight: waveformBox.height,
    };
  }

  async readCompactLayoutSnapshot(entry) {
    const [entryBounds, playBounds, actionBounds, mainBounds, topRowBounds, pitchBounds, timelineBounds, timeBounds, repeatBounds, speedBounds, headerBounds] = await Promise.all([
      entry.boundingBox(),
      this.playButtonForEntry(entry).boundingBox(),
      this.loopActionForEntry(entry).boundingBox(),
      this.utilityMainForEntry(entry).boundingBox(),
      this.topRowForEntry(entry).boundingBox(),
      this.pitchControlForEntry(entry).boundingBox(),
      this.timelineWrapForEntry(entry).boundingBox(),
      this.savedLoopTimeForEntry(entry).boundingBox(),
      this.repeatButtonForEntry(entry).boundingBox(),
      this.speedControlForEntry(entry).boundingBox(),
      this.detailHeader.boundingBox(),
    ]);
    if (!entryBounds || !playBounds || !actionBounds || !mainBounds || !topRowBounds || !timelineBounds || !timeBounds || !repeatBounds || !speedBounds || !headerBounds) {
      throw new Error('Expected rendered compact saved-loop controls and top row.');
    }
    return {
      entryBounds,
      playBounds,
      scissorsBounds: actionBounds,
      mainBounds,
      topRowBounds,
      pitchBounds,
      timelineBounds,
      timeBounds,
      repeatBounds,
      speedBounds,
      headerBounds,
      firstEntryGap: entryBounds.y - (headerBounds.y + headerBounds.height),
      timeSlotCount: await entry.locator('[data-loop-time]').count(),
      legacyBoundaryTimeCount: await entry.locator('[data-loop-range-time]').count(),
      pitchText: String(await this.pitchControlForEntry(entry).textContent() || '').replace(/\s+/g, ' ').trim(),
      ordinaryTimelineVisible: await this.ordinaryTimelineForEntry(entry).isVisible(),
    };
  }

  async readLoopActionVisualSnapshot(entry) {
    const action = this.loopActionForEntry(entry);
    const [rootBounds, podBounds, entryBounds, mainBounds, timelineBounds] = await Promise.all([
      action.boundingBox(),
      this.loopPodForEntry(entry).boundingBox(),
      entry.boundingBox(),
      this.utilityMainForEntry(entry).boundingBox(),
      this.timelineWrapForEntry(entry).boundingBox(),
    ]);
    if (!rootBounds || !podBounds || !entryBounds || !mainBounds || !timelineBounds) {
      throw new Error('Expected rendered saved-loop action and player geometry.');
    }
    // parity-check: allow-read-only-measurement-evaluate -- inspect rendered shared-loop visual state only
    const styles = await action.evaluate((root) => {
      const read = (selector) => {
        const element = root.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        return { color: style.color, cursor: style.cursor, display: style.display, opacity: Number(style.opacity), textShadow: style.textShadow };
      };
      return {
        state: root.getAttribute('data-loop-action-state'),
        engaged: root.getAttribute('data-loop-action-engaged'),
        pod: read('[data-loop-action-pod]'),
        enter: read('[data-loop-action="enter"]'),
        create: read('[data-loop-action="create"]'),
        cancel: read('[data-loop-action="cancel"]'),
        divider: read('[data-loop-action-divider]'),
      };
    });
    return { rootBounds, podBounds, entryBounds, mainBounds, timelineBounds, styles };
  }

  async readSavedLoopVisualSnapshot(entry) {
    const loopId = String(await entry.getAttribute('data-utility-loop-entry') || '');
    const waveform = this.savedLoopWaveformForEntry(entry, loopId);
    const [waveformBounds, timelineBounds] = await Promise.all([
      waveform.boundingBox(),
      this.ordinaryTimelineForEntry(entry).boundingBox(),
    ]);
    if (!waveformBounds || !timelineBounds) throw new Error('Expected rendered saved-loop waveform and live playhead.');
    // parity-check: allow-read-only-measurement-evaluate -- inspect combined waveform symmetry and live playhead rendering
    const canvas = await waveform.evaluate((element) => {
      const pixels = element.getContext('2d')?.getImageData(0, 0, element.width, element.height).data || [];
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
    // parity-check: allow-read-only-measurement-evaluate -- inspect the visible saved-loop playhead only
    const timeline = await this.ordinaryTimelineForEntry(entry).evaluate((element) => ({
      appearance: getComputedStyle(element).appearance,
      opacity: Number(getComputedStyle(element).opacity),
      trackBackground: getComputedStyle(element, '::-webkit-slider-runnable-track').backgroundColor,
      value: Number(element.value || 0),
      maximum: Number(element.max || 0),
      visible: !element.hidden && getComputedStyle(element).visibility !== 'hidden',
    }));
    // parity-check: allow-read-only-measurement-evaluate -- verify the canvas owns the saved-loop playhead paint
    const playhead = await waveform.evaluate((element, progressRatio) => {
      const pixels = element.getContext('2d')?.getImageData(0, 0, element.width, element.height).data || [];
      const playheadX = Math.max(0, Math.min(element.width - 1, Math.round(element.width * progressRatio)));
      let paintedRows = 0;
      for (let y = 0; y < element.height; y += 1) {
        if (pixels[((y * element.width + playheadX) * 4) + 3] > 0) paintedRows += 1;
      }
      return { paintedRowRatio: paintedRows / Math.max(1, element.height) };
    }, timeline.maximum > 0 ? timeline.value / timeline.maximum : 0);
    return { canvas, playhead, timeline, waveformBounds, timelineBounds };
  }

  audioByLoopId(loopId) {
    return this.page.locator(this.audioSelectorByLoopId(loopId));
  }

  async readAudioSnapshot(loopId) {
    const audio = this.audioByLoopId(loopId);
    // parity-check: allow-read-only-measurement-evaluate -- inspect native media state without mutating the app
    return audio.evaluate((element) => ({
      connected: element.isConnected,
      currentTime: Number(element.currentTime || 0),
      duration: Number(element.duration || 0),
      paused: Boolean(element.paused),
      playbackRate: Number(element.playbackRate || 0),
      pitch: Number(element.dataset.pitch || 0),
      speed: Number(element.dataset.speed || 0),
      src: String(element.currentSrc || element.getAttribute('src') || ''),
    }));
  }

  async captureAudioHandle(loopId) {
    const handle = await this.audioByLoopId(loopId).elementHandle();
    if (!handle) throw new Error('Expected saved-loop audio for ' + loopId + '.');
    return handle;
  }

  async readAudioContinuity(previousHandle, loopId) {
    const currentHandle = await this.captureAudioHandle(loopId);
    // parity-check: allow-read-only-measurement-evaluate -- compare retained/current audio node identity only
    const sameNode = await previousHandle.evaluate(
      (previousNode, currentNode) => previousNode === currentNode && currentNode.isConnected,
      currentHandle,
    );
    return {
      sameNode,
      snapshot: await this.readAudioSnapshot(loopId),
    };
  }

  audioSelectorByLoopId(loopId) {
    return `[data-loop-audio="${loopId}"]`;
  }

  get detailHeaderTitleSelector() {
    return '#utility-problematic-detail .utility-loop-detail-header .utility-detail-title';
  }
}
