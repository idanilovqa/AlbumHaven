import { expect } from '@playwright/test';
import { decodeAudioSampleEvidence } from '../helpers/loopPlaybackEvidence.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';

function parseLoopTimeLabel(label) {
  const match = /^(?:(\d+):)?(\d+):([0-5]\d)\.(\d{3})$/.exec(String(label).trim());
  if (!match) return Number.NaN;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2]);
  if (match[1] !== undefined && minutes >= 60) return Number.NaN;
  return (hours * 3600) + (minutes * 60) + Number(match[3]) + (Number(match[4]) / 1000);
}

export class UtilityLoopsActions {
  constructor(utilityLoopsTab) {
    this.utilityLoopsTab = utilityLoopsTab;
  }

  async waitForLoopPlayback(loopId, options = {}) {
    await this.utilityLoopsTab.waitForPageCondition((audioSelector) => {
      const audio = document.querySelector(audioSelector);
      return audio instanceof HTMLMediaElement
        && Number(audio.duration || 0) > 0
        && !audio.paused;
    }, {
      timeout: options.timeout || 10000,
    }, this.utilityLoopsTab.loopEntryCard.audioSelectorByLoopId(loopId));
  }

  async waitForLoopPlaybackState(loopId, expected, options = {}) {
    await this.utilityLoopsTab.waitForPageCondition((checkpoint) => {
      const audio = document.querySelector(checkpoint.audioSelector);
      return audio instanceof HTMLMediaElement
        && Boolean(audio.paused) === checkpoint.paused;
    }, {
      timeout: options.timeout || 10000,
    }, {
      audioSelector: this.utilityLoopsTab.loopEntryCard.audioSelectorByLoopId(loopId),
      paused: Boolean(expected.paused),
    });
    return this.readLoopPlaybackSnapshot(loopId);
  }

  async waitForLoopMediaReady(loopId, options = {}) {
    await this.utilityLoopsTab.waitForPageCondition((audioSelector) => {
      const audio = document.querySelector(audioSelector);
      return audio instanceof HTMLMediaElement
        && (
          Number(audio.duration || 0) > 0
          || Number(audio.readyState || 0) >= 1
          || Number(audio.networkState || 0) === HTMLMediaElement.NETWORK_IDLE
        );
    }, {
      timeout: options.timeout || 10000,
    }, this.utilityLoopsTab.loopEntryCard.audioSelectorByLoopId(loopId));
  }

  async waitForReady(options = {}) {
    await this.utilityLoopsTab.waitForPageCondition((selectors) => {
      if (typeof state === 'undefined' || state.utility?.activeTab !== 'loops') return false;
      if (state.utility?.loopsLoading) return false;
      return Boolean(document.querySelector(selectors.treeSelector))
        || Boolean(document.querySelector(selectors.emptyStateSelector));
    }, {
      timeout: options.timeout || 60000,
    }, {
      treeSelector: this.utilityLoopsTab.loopTree.treeSelector,
      emptyStateSelector: this.utilityLoopsTab.mainBody.emptyStateSelector,
    });
  }

  async readSummary() {
    const emptyStateCount = await this.utilityLoopsTab.emptyState.count();
    return {
      groupCount: await this.utilityLoopsTab.loopTree.trees.count(),
      entryCount: await this.utilityLoopsTab.loopEntryCard.entries.count(),
      hasHeader: await this.utilityLoopsTab.loopEntryCard.detailHeader.count() > 0,
      emptyState: emptyStateCount
        ? String(await this.utilityLoopsTab.emptyState.textContent() || '').trim()
        : '',
    };
  }

  async selectGroupByTitle(title, options = {}) {
    await this.utilityLoopsTab.loopTree.groupButtonByTitle(title).click();
    await this.utilityLoopsTab.waitForPageCondition((expected) => {
      const headerTitle = (document.querySelector(expected.detailHeaderTitleSelector)?.textContent || '').trim();
      return headerTitle === expected.title;
    }, {
      timeout: options.timeout || 60000,
    }, {
      title,
      detailHeaderTitleSelector: this.utilityLoopsTab.loopEntryCard.detailHeaderTitleSelector,
    });
  }

  async readGroupSummaryByTitle(title) {
    const button = this.utilityLoopsTab.loopTree.groupButtonByTitle(title);
    return {
      title: ((await this.utilityLoopsTab.loopTree.titleForGroup(button).textContent()) || '').trim(),
      meta: ((await this.utilityLoopsTab.loopTree.metaForGroup(button).textContent()) || '').trim(),
      countText: ((await this.utilityLoopsTab.loopTree.countForGroup(button).textContent()) || '').trim(),
    };
  }

  async readDetailSummary() {
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    return {
      title: String(await entryCard.detailTitle.textContent() || '').trim(),
      meta: (await entryCard.detailMetas.allTextContents())
        .map((value) => String(value || '').trim())
        .filter(Boolean),
      entryCount: await entryCard.detailEntries.count(),
    };
  }

  async resolveLoopEntryByName(name) {
    const entry = this.utilityLoopsTab.loopEntryCard.entryByName(name);
    const matchingEntryCount = await entry.count();
    if (matchingEntryCount !== 1) {
      throw new Error(
        'Expected exactly one saved loop entry named '
        + JSON.stringify(name)
        + ', found '
        + matchingEntryCount
        + '. Use a stable loop identity when names are duplicated.',
      );
    }
    const loopId = String(await entry.getAttribute('data-utility-loop-entry') || '');
    if (!loopId) {
      throw new Error('Expected a saved loop entry named ' + JSON.stringify(name) + '.');
    }
    return { entry, loopId };
  }

  async pressSpaceBeforeLoopOwnership(groupTitle, options = {}) {
    const neutralControl = this.utilityLoopsTab.loopTree.groupButtonByTitle(groupTitle);
    await neutralControl.focus();
    await expect(neutralControl).toBeFocused();
    await neutralControl.press('Space');
    await options.afterSpace?.();
    await expect(neutralControl).toBeFocused();
  }

  async pressSpaceForOwnedLoopByName(name, expected, options = {}) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const playButton = this.utilityLoopsTab.loopEntryCard.playButtonForEntry(entry);
    await playButton.focus();
    await expect(playButton).toBeFocused();
    await playButton.press('Space');
    const snapshot = await this.waitForLoopPlaybackState(loopId, expected, options);
    await expect(playButton).toBeFocused();
    return { loopId, snapshot };
  }

  async pressNeutralSpaceForOwnedLoop(groupTitle, loopId, expected, options = {}) {
    const neutralControl = this.utilityLoopsTab.loopTree.groupButtonByTitle(groupTitle);
    await neutralControl.focus();
    await expect(neutralControl).toBeFocused();
    await neutralControl.press('Space');
    const snapshot = await this.waitForLoopPlaybackState(loopId, expected, options);
    await expect(neutralControl).toBeFocused();
    return snapshot;
  }

  async pressNeutralSpaceAfterGlobalReclaim(groupTitle, loopId, expectedLoop, options = {}) {
    const neutralControl = this.utilityLoopsTab.loopTree.groupButtonByTitle(groupTitle);
    await neutralControl.focus();
    await expect(neutralControl).toBeFocused();
    await neutralControl.press('Space');
    await options.afterSpace?.();
    const snapshot = await this.waitForLoopPlaybackState(loopId, expectedLoop, options);
    await expect(neutralControl).toBeFocused();
    return snapshot;
  }

  async pressSpaceAfterLoopOwnershipReset(groupTitle, options = {}) {
    const neutralControl = this.utilityLoopsTab.loopTree.groupButtonByTitle(groupTitle);
    await neutralControl.focus();
    await expect(neutralControl).toBeFocused();
    await neutralControl.press('Space');
    await options.afterSpace?.();
    await expect(neutralControl).toBeFocused();
  }

  async readLoopPlaybackSnapshot(loopId) {
    return this.utilityLoopsTab.loopEntryCard.readAudioSnapshot(loopId);
  }

  async readDecodedLoopSampleEvidence(loopId) {
    const snapshot = await this.readLoopPlaybackSnapshot(loopId);
    if (!snapshot.src) throw new Error(`Loop ${loopId} has no exact current source.`);
    const response = await authenticatedPageGet(this.utilityLoopsTab.page, snapshot.src);
    if (!response.ok()) {
      throw new Error(`Loop media returned HTTP ${response.status()} for ${snapshot.src}.`);
    }
    return {
      currentSrc: snapshot.src,
      ...decodeAudioSampleEvidence(await response.body()),
    };
  }

  async captureLoopAudioHandle(loopId) {
    return this.utilityLoopsTab.loopEntryCard.captureAudioHandle(loopId);
  }

  async readLoopContinuity(previousHandle, loopId) {
    return this.utilityLoopsTab.loopEntryCard.readAudioContinuity(previousHandle, loopId);
  }

  async readLoopEditorStateByName(name) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const snapshot = await this.utilityLoopsTab.loopEntryCard.readSavedLoopEditorSnapshot(entry);
    return {
      ...snapshot,
      loopId,
      startSeconds: snapshot.startLabel === undefined
        ? Number.NaN
        : parseLoopTimeLabel(snapshot.startLabel),
      endSeconds: snapshot.endLabel === undefined
        ? Number.NaN
        : parseLoopTimeLabel(snapshot.endLabel),
    };
  }

  async readCompactLoopLayoutByName(name) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    return {
      loopId,
      ...await this.utilityLoopsTab.loopEntryCard.readCompactLayoutSnapshot(entry),
    };
  }

  async readSidebarExpansionSummary() {
    return {
      groupCount: await this.utilityLoopsTab.loopTree.groupButtons.count(),
      expandedGroupCount: await this.utilityLoopsTab.loopTree.expandedToggles.count(),
      childLoopCount: await this.utilityLoopsTab.loopTree.childButtons.count(),
    };
  }

  async expandGroupByTitle(title) {
    const groupButton = this.utilityLoopsTab.loopTree.groupButtonByTitle(title);
    const toggle = this.utilityLoopsTab.loopTree.collapseToggleForGroup(groupButton);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(this.utilityLoopsTab.loopTree.collapseToggleForGroup(
      this.utilityLoopsTab.loopTree.groupButtonByTitle(title),
    )).toHaveAttribute('aria-expanded', 'true');
  }

  async readLoopActionVisualStateByName(name) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    return { loopId, ...await this.utilityLoopsTab.loopEntryCard.readLoopActionVisualSnapshot(entry) };
  }

  async hoverLoopActionByName(name, target = 'enter') {
    const { entry } = await this.resolveLoopEntryByName(name);
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    const locator = target === 'create'
      ? entryCard.loopCreateButtonForEntry(entry)
      : target === 'cancel'
        ? entryCard.loopCancelButtonForEntry(entry)
        : entryCard.loopScissorsButtonForEntry(entry);
    const bounds = await locator.boundingBox();
    if (!bounds) throw new Error(`Expected the ${target} loop action for ${JSON.stringify(name)} to have rendered bounds.`);
    await this.utilityLoopsTab.page.mouse.move(
      bounds.x + (bounds.width / 2),
      bounds.y + (bounds.height / 2),
    );
    await expect(entryCard.loopActionForEntry(entry))
      .toHaveAttribute('data-loop-action-engaged', 'true');
    await expect(entryCard.loopPodForEntry(entry)).toHaveCSS('width', '55px');
    return entryCard.readLoopActionVisualSnapshot(entry);
  }

  async moveAwayFromLoopActionByName(name) {
    const { entry } = await this.resolveLoopEntryByName(name);
    await this.utilityLoopsTab.page.mouse.move(2, 2);
    await expect(this.utilityLoopsTab.loopEntryCard.loopActionForEntry(entry))
      .toHaveAttribute('data-loop-action-engaged', 'false');
    await expect(this.utilityLoopsTab.loopEntryCard.loopPodForEntry(entry)).toHaveCSS('width', '39px');
    return this.utilityLoopsTab.loopEntryCard.readLoopActionVisualSnapshot(entry);
  }

  async readSavedLoopVisualStateByName(name) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    return { loopId, ...await this.utilityLoopsTab.loopEntryCard.readSavedLoopVisualSnapshot(entry) };
  }

  async activateCreateAnotherLoopByName(name) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    await this.utilityLoopsTab.loopEntryCard.loopCreateButtonForEntry(entry).click();
    return loopId;
  }

  async activateCreateAnotherLoopWithEnterByName(name) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const requests = [];
    const observe = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') requests.push(request);
    };
    this.utilityLoopsTab.page.on('request', observe);
    try {
      const focusTarget = this.utilityLoopsTab.loopEntryCard.savedLoopBoundaryHandleForEntry(
        entry,
        'start',
        loopId,
      );
      await focusTarget.focus();
      await expect(focusTarget).toBeFocused();
      await focusTarget.press('Enter');
    } finally {
      this.utilityLoopsTab.page.off('request', observe);
    }
    return { loopId, requestCount: requests.length };
  }

  async revealCreateAnotherLoopEditorByName(name, options = {}) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    await this.utilityLoopsTab.loopEntryCard.loopScissorsButtonForEntry(entry).click();
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    await expect(entryCard.savedLoopEditRangeForEntry(entry, loopId)).toBeVisible({
      timeout: options.timeout || 60000,
    });
    await expect(entryCard.savedLoopWaveformForEntry(entry, loopId)).toBeVisible({
      timeout: options.timeout || 60000,
    });
    await expect(entryCard.savedLoopBoundaryHandleForEntry(entry, 'start', loopId)).toBeVisible({
      timeout: options.timeout || 60000,
    });
    await expect(entryCard.savedLoopBoundaryHandleForEntry(entry, 'end', loopId)).toBeVisible({
      timeout: options.timeout || 60000,
    });
    return {
      loopId,
      ...await entryCard.readSavedLoopEditorSnapshot(entry),
    };
  }

  async cancelCreateAnotherLoopByName(name, options = {}) {
    const { entry } = await this.resolveLoopEntryByName(name);
    const requests = [];
    const observe = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') requests.push(request);
    };
    this.utilityLoopsTab.page.on('request', observe);
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    try {
      await entryCard.loopCancelButtonForEntry(entry).click();
      await expect(entryCard.loopActionForEntry(entry)).toHaveAttribute('data-loop-action-state', 'idle');
      await expect(entryCard.savedLoopMainSurfaceForEntry(entry)).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(entryCard.savedLoopEditRangeForEntry(entry)).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(entryCard.ordinaryTimelineForEntry(entry)).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(entryCard.ordinaryTimeForEntry(entry)).toBeVisible({ timeout: options.timeout || 60000 });
    } finally {
      this.utilityLoopsTab.page.off('request', observe);
    }
    return { requestCount: requests.length };
  }

  async escapeCreateAnotherLoopByName(name, options = {}) {
    const { entry } = await this.resolveLoopEntryByName(name);
    const requests = [];
    const observe = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/create') requests.push(request);
    };
    this.utilityLoopsTab.page.on('request', observe);
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    try {
      const focusTarget = options.focusTarget === 'repeat'
        ? entryCard.repeatButtonForEntry(entry)
        : entryCard.savedLoopBoundaryHandleForEntry(entry, 'start');
      await focusTarget.focus();
      await expect(focusTarget).toBeFocused();
      await focusTarget.press('Escape');
      await expect(entry).toBeVisible();
      await expect(entryCard.loopActionForEntry(entry)).toHaveAttribute('data-loop-action-state', 'idle');
      await expect(entryCard.savedLoopMainSurfaceForEntry(entry)).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(entryCard.savedLoopEditRangeForEntry(entry)).toBeHidden({ timeout: options.timeout || 60000 });
      await expect(entryCard.ordinaryTimelineForEntry(entry)).toBeVisible({ timeout: options.timeout || 60000 });
      await expect(entryCard.ordinaryTimeForEntry(entry)).toBeVisible({ timeout: options.timeout || 60000 });
    } finally {
      this.utilityLoopsTab.page.off('request', observe);
    }
    return { requestCount: requests.length };
  }

  async clickLoopRangeByName(name, targetFraction) {
    const fraction = Math.min(0.98, Math.max(0.02, Number(targetFraction)));
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const waveform = this.utilityLoopsTab.loopEntryCard.savedLoopWaveformForEntry(entry, loopId);
    const waveformBox = await waveform.boundingBox();
    if (!waveformBox) throw new Error('Expected a rendered saved-loop waveform.');
    const before = await this.readLoopEditorStateByName(name);
    await this.utilityLoopsTab.page.mouse.click(
      waveformBox.x + (waveformBox.width * fraction),
      waveformBox.y + (waveformBox.height / 2),
    );
    const targetSeconds = before.duration * fraction;
    await expect.poll(
      async () => (await this.readLoopPlaybackSnapshot(loopId)).currentTime,
      { timeout: 60000 },
    ).toBeCloseTo(targetSeconds, 0);
    return {
      targetFraction: fraction,
      targetSeconds,
      playback: await this.readLoopPlaybackSnapshot(loopId),
      before,
      after: await this.readLoopEditorStateByName(name),
    };
  }

  async dragLoopBoundaryByName(name, boundary, targetFraction) {
    const normalizedBoundary = String(boundary);
    if (!['start', 'end'].includes(normalizedBoundary)) {
      throw new Error('Loop boundary must be start or end.');
    }
    const fraction = Math.min(0.95, Math.max(0.05, Number(targetFraction)));
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    const waveform = entryCard.savedLoopWaveformForEntry(entry, loopId);
    const handle = entryCard.savedLoopBoundaryHandleForEntry(entry, normalizedBoundary, loopId);
    const waveformBox = await waveform.boundingBox();
    const handleBox = await handle.boundingBox();
    if (!waveformBox || !handleBox) {
      throw new Error('Expected rendered waveform and loop boundary handle bounds before dragging.');
    }
    await handle.hover();
    await this.utilityLoopsTab.page.mouse.down();
    await this.utilityLoopsTab.page.mouse.move(
      waveformBox.x + (waveformBox.width * fraction),
      waveformBox.y + (waveformBox.height / 2),
      { steps: 8 },
    );
    const dragSnapshot = await this.readLoopEditorStateByName(name);
    await this.utilityLoopsTab.page.mouse.up();
    return {
      ...await this.readLoopEditorStateByName(name),
      dragSnapshot,
    };
  }

  async expectCreateAnotherLoopEditorActiveByName(name, options = {}) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    await expect(entryCard.loopActionForEntry(entry)).toHaveAttribute('data-loop-action-state', 'editing', {
      timeout: options.timeout || 60000,
    });
    await expect(entryCard.savedLoopEditRangeForEntry(entry, loopId)).toBeVisible({
      timeout: options.timeout || 60000,
    });
    return this.readLoopPlaybackSnapshot(loopId);
  }

  async waitForAutomaticLoopEditorExpiryByName(name, options = {}) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    await expect(entryCard.loopActionForEntry(entry)).toHaveAttribute('data-loop-action-state', 'idle', {
      timeout: options.timeout || 60000,
    });
    await expect(entryCard.savedLoopEditRangeForEntry(entry, loopId)).toBeHidden({
      timeout: options.timeout || 60000,
    });
    return this.waitForLoopPlaybackState(loopId, { paused: true }, options);
  }

  async waitForLoopProgress(loopId, options = {}) {
    const afterCurrentTime = Math.max(0, Number(options.afterCurrentTime) || 0);
    const minimumDelta = Math.max(0.05, Number(options.minimumDelta) || 0.2);
    await this.utilityLoopsTab.waitForPageCondition((expected) => {
      const audio = document.querySelector(expected.audioSelector);
      if (!(audio instanceof HTMLMediaElement) || audio.paused) return false;
      const currentTime = Number(audio.currentTime || 0);
      return currentTime >= expected.afterCurrentTime + expected.minimumDelta
        || (
          expected.allowWrap
          && expected.afterCurrentTime >= expected.minimumDelta
          && currentTime <= expected.afterCurrentTime - expected.minimumDelta
        );
    }, {
      timeout: options.timeout || 60000,
    }, {
      audioSelector: this.utilityLoopsTab.loopEntryCard.audioSelectorByLoopId(loopId),
      afterCurrentTime,
      minimumDelta,
      allowWrap: options.allowWrap !== false,
    });
    return this.readLoopPlaybackSnapshot(loopId);
  }

  async enableRepeatByName(name) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const repeatButton = this.utilityLoopsTab.loopEntryCard.repeatButtonForEntry(entry);
    if (await repeatButton.getAttribute('aria-pressed') !== 'true') {
      await repeatButton.click();
    }
    await expect(repeatButton).toHaveAttribute('aria-pressed', 'true');
    return loopId;
  }

  async readRepeatPressedByName(name) {
    const { entry } = await this.resolveLoopEntryByName(name);
    return this.utilityLoopsTab.loopEntryCard.repeatPressedForEntry(entry);
  }

  async waitForRepeatCycle(loopId, options = {}) {
    const initial = await this.readLoopPlaybackSnapshot(loopId);
    const nearEnd = Math.max(0.4, initial.duration - 0.35);
    await this.utilityLoopsTab.waitForPageCondition((expected) => {
      const audio = document.querySelector(expected.audioSelector);
      return audio instanceof HTMLMediaElement
        && !audio.paused
        && Number(audio.currentTime || 0) >= expected.nearEnd;
    }, {
      timeout: options.timeout || 60000,
    }, {
      audioSelector: this.utilityLoopsTab.loopEntryCard.audioSelectorByLoopId(loopId),
      nearEnd,
    });
    await this.utilityLoopsTab.waitForPageCondition((expected) => {
      const audio = document.querySelector(expected.audioSelector);
      return audio instanceof HTMLMediaElement
        && !audio.paused
        && Number(audio.currentTime || 0) <= expected.restartCeiling;
    }, {
      timeout: options.timeout || 60000,
    }, {
      audioSelector: this.utilityLoopsTab.loopEntryCard.audioSelectorByLoopId(loopId),
      restartCeiling: Math.min(0.45, Math.max(0.2, initial.duration * 0.3)),
    });
    return this.waitForLoopProgress(loopId, {
      afterCurrentTime: 0,
      minimumDelta: 0.2,
      allowWrap: false,
      timeout: options.timeout || 60000,
    });
  }

  async setSpeedByName(name, speed, options = {}) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const before = await this.readLoopPlaybackSnapshot(loopId);
    await this.utilityLoopsTab.loopEntryCard.speedValueButtonForEntry(entry).click();
    await this.utilityLoopsTab.loopEntryCard.speedOptionForEntry(entry, speed).click();
    await expect(this.utilityLoopsTab.loopEntryCard.speedValueButtonForEntry(entry))
      .toHaveText(Number(speed).toFixed(2).replace(/\.?0+$/, '') + 'x');
    return this.waitForLoopProgress(loopId, {
      afterCurrentTime: before.currentTime,
      timeout: options.timeout || 60000,
    });
  }

  async stepPitchByName(name, step, expectedLabel, options = {}) {
    const { entry, loopId } = await this.resolveLoopEntryByName(name);
    const requested = await this.readLoopPlaybackSnapshot(loopId);
    const pitchResponse = this.utilityLoopsTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/loops/pitch-preview'
    ), { timeout: options.timeout || 60000 });
    await this.utilityLoopsTab.loopEntryCard.pitchStepButtonForEntry(entry, step).click();
    const response = await pitchResponse;
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true) {
      throw new Error(
        'Pitch preview failed with HTTP ' + response.status() + ': ' + JSON.stringify(payload),
      );
    }
    const mediaUrl = String(payload.media_url || '').trim();
    if (!mediaUrl) {
      throw new Error('Successful pitch preview response omitted media_url.');
    }
    await this.utilityLoopsTab.waitForPageCondition((expected) => {
      const audio = document.querySelector(expected.audioSelector);
      const source = String(audio?.currentSrc || audio?.getAttribute?.('src') || '');
      return audio instanceof HTMLMediaElement
        && source.includes(expected.mediaUrl)
        && !audio.paused;
    }, {
      timeout: options.timeout || 60000,
    }, {
      audioSelector: this.utilityLoopsTab.loopEntryCard.audioSelectorByLoopId(loopId),
      mediaUrl,
    });
    await expect(this.utilityLoopsTab.loopEntryCard.pitchValueForEntry(entry))
      .toHaveText(expectedLabel, { timeout: options.timeout || 60000 });
    await this.waitForLoopPlayback(loopId, { timeout: options.timeout || 60000 });
    const restored = await this.readLoopPlaybackSnapshot(loopId);
    const progressed = await this.waitForLoopProgress(loopId, {
      afterCurrentTime: restored.currentTime,
      timeout: options.timeout || 60000,
    });
    return { requested, restored, progressed };
  }

  async playLoopByName(name, options = {}) {
    const entry = this.utilityLoopsTab.loopEntryCard.entryByName(name);
    const matchingEntryCount = await entry.count();
    if (matchingEntryCount !== 1) {
      throw new Error(
        `Expected exactly one saved loop entry named ${JSON.stringify(name)}, found ${matchingEntryCount}. Use a stable loop identity when names are duplicated.`,
      );
    }
    const loopId = String(await entry.getAttribute('data-utility-loop-entry') || '');
    if (!loopId) {
      throw new Error(`Expected a saved loop entry named ${JSON.stringify(name)}.`);
    }
    const playButton = this.utilityLoopsTab.loopEntryCard.playButtonForEntry(entry);
    await playButton.click();
    await this.waitForLoopMediaReady(loopId, { timeout: options.timeout || 60000 });
    await this.waitForLoopPlayback(loopId, { timeout: options.timeout || 60000 });
    const started = await this.readLoopPlaybackSnapshot(loopId);
    await this.waitForLoopProgress(loopId, {
      afterCurrentTime: started.currentTime,
      minimumDelta: 0.2,
      allowWrap: false,
      timeout: options.timeout || 60000,
    });
    return loopId;
  }

  async openDeleteConfirmationByName(name) {
    const { entry } = await this.resolveLoopEntryByName(name);
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    const nativeDialogs = [];
    const recordNativeDialog = async (dialog) => {
      nativeDialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss();
    };
    this.utilityLoopsTab.page.on('dialog', recordNativeDialog);
    try {
      await entryCard.deleteButtonForEntry(entry).click();
      await expect(entryCard.deleteConfirmDialog).toBeVisible();
      await expect(entryCard.deleteConfirmNo).toBeFocused();
      return {
        nativeDialogs,
        text: String(await entryCard.deleteConfirmText.textContent() || '').trim(),
        stacking: await entryCard.readDeleteConfirmationStack(),
      };
    } finally {
      this.utilityLoopsTab.page.off('dialog', recordNativeDialog);
    }
  }

  async cancelDeleteConfirmationByName(name) {
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    let requestCount = 0;
    const countDeleteRequest = (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/loops/delete') {
        requestCount += 1;
      }
    };
    this.utilityLoopsTab.page.on('request', countDeleteRequest);
    try {
      await entryCard.deleteConfirmNo.click();
      await expect(entryCard.deleteConfirmOverlay).toBeHidden();
      await expect(this.utilityLoopsTab.loopEntryCard.entryByName(name)).toHaveCount(1);
      return { requestCount };
    } finally {
      this.utilityLoopsTab.page.off('request', countDeleteRequest);
    }
  }

  async selectDeleteConfirmationTextOutsideDialog() {
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    await entryCard.selectDeleteConfirmationTextAndReleaseOnBackdrop();
    await expect(entryCard.deleteConfirmDialog).toBeVisible();
    return String(await entryCard.deleteConfirmText.textContent() || '').trim();
  }

  async confirmDeleteByName(name, options = {}) {
    const entryCard = this.utilityLoopsTab.loopEntryCard;
    const responsePromise = this.utilityLoopsTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/loops/delete'
    ), { timeout: options.timeout || 60000 });
    await entryCard.deleteConfirmYes.click();
    const response = await responsePromise;
    const payload = await response.json();
    expect(response.ok()).toBe(true);
    expect(payload?.ok).toBe(true);
    await expect(entryCard.deleteConfirmOverlay).toBeHidden();
    await expect(entryCard.entryByName(name)).toHaveCount(0, { timeout: options.timeout || 60000 });
    return { requestCount: 1 };
  }
}
