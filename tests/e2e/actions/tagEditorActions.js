import { expect } from '@playwright/test';

export class TagEditorActions {
  constructor(tagEditor) {
    this.tagEditor = tagEditor;
  }

  async waitForOpen(options = {}) {
    const timeout = options.timeout || 30000;
    await expect(this.tagEditor.dialog).toBeVisible({ timeout });
    if (options.expectedTrackCount !== undefined) {
      await expect(this.tagEditor.trackButtons).toHaveCount(
        Number(options.expectedTrackCount),
        { timeout },
      );
    }
  }

  async openForAlbum({
    album,
    artist,
    expectedTrackCount,
    galleryActions,
    trackModalActions,
    year,
  }) {
    await galleryActions.selectAlbumDetailsByIdentity({ artist, album, year });
    await trackModalActions.waitForInteractiveSummary();
    await trackModalActions.openTagEditor();
    await this.waitForOpen({ expectedTrackCount });
  }

  async readSummary() {
    return {
      subtitle: String(await this.tagEditor.subtitle.textContent() || '').trim(),
      trackFilenames: (await this.tagEditor.trackTitles.allTextContents())
        .map((value) => value.trim())
        .filter(Boolean),
      activeTrackCount: await this.tagEditor.activeTrackButtons.count(),
      exceptionType: String(await this.tagEditor.exceptionSelect.inputValue() || ''),
      alertText: String(await this.tagEditor.repairAlertMessage.textContent() || '').trim(),
    };
  }

  async observeTaskNotificationLifecycleDuring(action, options = {}) {
    const timeout = options.timeout || 60000;
    const observation = await this.tagEditor.startRepairAlertLifecycleObservation();
    try {
      const result = await action();
      await expect(this.tagEditor.repairAlert).toBeHidden({ timeout });
      const samples = await observation.finish();
      const visibleText = samples
        .filter((sample) => sample.visible && sample.text)
        .map((sample) => sample.text)
        .filter((text, index, allText) => index === 0 || text !== allText[index - 1]);
      const runningIndex = visibleText.indexOf('Writing tag changes...');
      const successText = 'Tag changes saved.';
      const successIndexes = visibleText
        .map((text, index) => (text === successText ? index : -1))
        .filter((index) => index >= 0);
      expect(
        runningIndex,
        `Expected task-scoped running notification. Observed: ${JSON.stringify(samples)}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        successIndexes.length,
        `Expected one success notification state. Observed: ${JSON.stringify(samples)}`,
      ).toBe(1);
      expect(successIndexes[0]).toBeGreaterThan(runningIndex);
      expect(visibleText).not.toContain('Tag changes queued. Finalizing library view...');
      expect(visibleText).not.toContain('Library view updated from saved files.');
      expect(
        samples.filter((sample) => sample.visible && sample.error),
        `A successful filesystem tag edit displayed an error notification: ${JSON.stringify(samples)}`,
      ).toEqual([]);
      expect(samples.at(-1)?.visible).toBe(false);
      return { result, samples };
    } catch (error) {
      const samples = await observation.finish();
      throw new Error(
        `${error.message} Notification lifecycle: ${JSON.stringify(samples)}`,
        { cause: error },
      );
    }
  }

  async expectTerminalFailureRemainsReadable(expectedText, options = {}) {
    const stableDuration = options.stableDuration || 1500;
    const timeout = options.timeout || 30000;
    await expect(this.tagEditor.repairAlert).toBeVisible({ timeout });
    await expect(this.tagEditor.repairAlertMessage).toContainText(expectedText, { timeout });
    await expect(this.tagEditor.repairAlertMessage).not.toHaveText(
      'Library view updated from saved files.',
    );
    const initialText = String(
      await this.tagEditor.repairAlertMessage.textContent() || '',
    ).trim();
    await this.tagEditor.page.waitForTimeout(stableDuration);
    await expect(this.tagEditor.repairAlert).toBeVisible();
    await expect(this.tagEditor.repairAlertMessage).toHaveText(initialText);
    return initialText;
  }

  async readTrackPaths() {
    // parity-check: allow-read-only-measurement-evaluate -- atomically read production track-path identity attributes only
    return this.tagEditor.trackButtons.evaluateAll((buttons) => buttons.map(
      (button) => String(button.getAttribute('data-tag-editor-track') || '').trim(),
    ).filter(Boolean));
  }

  async readEditableValues(fields = ['album', 'title', 'genre', 'year']) {
    const inputs = {
      album: this.tagEditor.albumNameInput,
      title: this.tagEditor.trackNameInput,
      genre: this.tagEditor.genreInput,
      year: this.tagEditor.yearInput,
    };
    const values = {};
    for (const field of fields) {
      if (!inputs[field]) {
        throw new Error(`Unsupported editable tag field: ${field}`);
      }
      values[field] = await inputs[field].inputValue();
    }
    return values;
  }

  async selectTrackByFilename(filename) {
    const track = this.tagEditor.trackButtonByFilename(filename);
    await expect(track).toHaveCount(1);
    await track.scrollIntoViewIfNeeded();
    await expect(track).toBeVisible();
    await track.click();
    await expect(track).toHaveAttribute('aria-pressed', 'true');
  }

  async selectTracksByFilenames(filenames) {
    const expectedFilenames = [...new Set(
      filenames.map((filename) => String(filename || '').trim()).filter(Boolean),
    )];
    if (expectedFilenames.length < 1) {
      throw new Error('At least one filename is required for track selection.');
    }
    for (const [index, filename] of expectedFilenames.entries()) {
      const track = this.tagEditor.trackButtonByFilename(filename);
      await expect(track).toHaveCount(1);
      await track.click(index === 0 ? {} : { modifiers: ['Control'] });
      await expect(this.tagEditor.activeTrackButtons).toHaveCount(index + 1);
    }
    expect(await this.readSelectedTrackFilenames()).toEqual(expectedFilenames);
  }

  async dragSelectTracksByFilenames(filenames) {
    const expectedFilenames = filenames
      .map((filename) => String(filename || '').trim())
      .filter(Boolean);
    if (expectedFilenames.length < 2) {
      throw new Error('A drag-selected track range requires at least two filenames.');
    }
    const firstTrack = this.tagEditor.trackButtonByFilename(expectedFilenames[0]);
    const lastTrack = this.tagEditor.trackButtonByFilename(expectedFilenames.at(-1));
    await expect(firstTrack).toHaveCount(1);
    await expect(lastTrack).toHaveCount(1);
    await firstTrack.scrollIntoViewIfNeeded();
    await lastTrack.scrollIntoViewIfNeeded();
    const firstBox = await firstTrack.boundingBox();
    const lastBox = await lastTrack.boundingBox();
    if (!firstBox || !lastBox) {
      throw new Error('The drag-selected track range must be visible.');
    }
    await this.tagEditor.page.mouse.move(
      firstBox.x + firstBox.width / 2,
      firstBox.y + firstBox.height / 2,
    );
    await this.tagEditor.page.mouse.down();
    try {
      await this.tagEditor.page.mouse.move(
        lastBox.x + lastBox.width / 2,
        lastBox.y + lastBox.height / 2,
        { steps: 10 },
      );
    } finally {
      await this.tagEditor.page.mouse.up();
    }
    await expect(this.tagEditor.activeTrackButtons).toHaveCount(expectedFilenames.length);
    expect(await this.readSelectedTrackFilenames()).toEqual(expectedFilenames);
  }

  async readSelectedTrackFilenames() {
    return (await this.tagEditor.activeTrackTitles.allTextContents())
      .map((filename) => String(filename || '').trim())
      .filter(Boolean);
  }

  async selectAllTracks() {
    const trackCount = await this.tagEditor.trackButtons.count();
    if (trackCount < 1) {
      throw new Error('The tag editor has no tracks to select.');
    }

    const clickTrackButton = async (trackIndex, options = {}) => {
      const trackButton = this.tagEditor.trackButtons.nth(trackIndex);
      await trackButton.click(options);
    };

    await clickTrackButton(0);
    await expect(this.tagEditor.activeTrackButtons).toHaveCount(1);
    for (let trackIndex = 1; trackIndex < trackCount; trackIndex += 1) {
      await clickTrackButton(trackIndex, { modifiers: ['Control'] });
      await expect(this.tagEditor.activeTrackButtons).toHaveCount(trackIndex + 1);
    }
    await expect(this.tagEditor.activeTrackButtons).toHaveCount(trackCount);
  }

  async setAlbumName(albumName) {
    const expectedAlbumName = String(albumName || '').trim();
    if (!expectedAlbumName) {
      throw new Error('Album name cannot be empty.');
    }
    await this.tagEditor.albumNameInput.fill(expectedAlbumName);
    await expect(this.tagEditor.albumNameInput).toHaveValue(expectedAlbumName);
  }

  async expectAlbumName(albumName) {
    await expect(this.tagEditor.albumNameInput).toHaveValue(String(albumName || ''));
  }

  async clearAlbumName() {
    await this.tagEditor.albumNameInput.fill('');
    await expect(this.tagEditor.albumNameInput).toBeEmpty();
  }

  async expectBlankAlbumCanApply() {
    await expect(this.tagEditor.albumNameInput).not.toHaveAttribute('aria-invalid');
    await expect(this.tagEditor.albumNameInput).not.toHaveAttribute('aria-describedby');
    await expect(this.tagEditor.applyButton).toBeEnabled();
  }

  async setTrackName(trackName) {
    const expectedTrackName = String(trackName || '').trim();
    if (!expectedTrackName) {
      throw new Error('Track name cannot be empty.');
    }
    await this.tagEditor.trackNameInput.fill(expectedTrackName);
    await expect(this.tagEditor.trackNameInput).toHaveValue(expectedTrackName);
  }

  async setGenre(genre) {
    const expectedGenre = String(genre || '').trim();
    if (!expectedGenre) {
      throw new Error('Genre cannot be empty.');
    }
    await this.tagEditor.genreInput.fill(expectedGenre);
    await expect(this.tagEditor.genreInput).toHaveValue(expectedGenre);
  }

  async setYear(year) {
    const expectedYear = String(year || '').trim();
    if (!expectedYear) {
      throw new Error('Year cannot be empty.');
    }
    await this.tagEditor.yearInput.fill(expectedYear);
    await expect(this.tagEditor.yearInput).toHaveValue(expectedYear);
  }

  async setTrackNumber(trackNumber) {
    const expectedTrackNumber = String(trackNumber ?? '').trim();
    await this.tagEditor.trackNumberInput.fill(expectedTrackNumber);
    await expect(this.tagEditor.trackNumberInput).toHaveValue(expectedTrackNumber);
  }

  async setDiscNumber(discNumber) {
    const expectedDiscNumber = String(discNumber ?? '').trim();
    await this.tagEditor.discNumberInput.fill(expectedDiscNumber);
    await expect(this.tagEditor.discNumberInput).toHaveValue(expectedDiscNumber);
  }

  async expectAutoNumberSelectedState({ selectedCount, startAt, visible }) {
    await expect(this.tagEditor.activeTrackButtons).toHaveCount(Number(selectedCount));
    await expect(this.tagEditor.autoNumberControls).toHaveCount(1);
    if (visible) {
      await expect(this.tagEditor.autoNumberControls).toBeVisible();
      await expect(this.tagEditor.startAtInput).toBeVisible();
      await expect(this.tagEditor.startAtInput).toHaveValue(String(startAt));
      await expect(this.tagEditor.autoNumberButton).toBeEnabled();
    } else {
      await expect(this.tagEditor.autoNumberControls).toBeHidden();
    }
  }

  async expectApprovedAutoNumberStructure() {
    const fieldLabels = await this.tagEditor.readFormLabelTexts();
    expect(fieldLabels).toEqual([
      'Artist',
      'Album Artist',
      'Album Name',
      'Track Name',
      'Genre',
      'Year',
      'Track Number',
      'Disc Number',
      'Exception',
      'Edition',
      'Album Rating',
    ]);
    await expect(this.tagEditor.footer).toContainText(
      /^\s*Start at\s*Auto-number\s*Cancel\s*Apply\s*$/u,
    );
    await expect(this.tagEditor.autoNumberControls).toContainText(
      /^\s*Start at\s*Auto-number\s*$/u,
    );
    await expect(this.tagEditor.autoNumberHelp).toHaveCount(0);
    await expect(this.tagEditor.autoNumberStatus).toHaveCount(0);
    await expect(this.tagEditor.cancelButton).toBeVisible();
    await expect(this.tagEditor.applyButton).toBeVisible();
  }

  async setAutoNumberStart(startAt) {
    await this.tagEditor.startAtInput.fill(String(startAt));
    await expect(this.tagEditor.startAtInput).toHaveValue(String(startAt));
  }

  async expectAutoNumberResponsiveLayout() {
    await expect(this.tagEditor.dialog).toBeVisible();
    await expect(this.tagEditor.autoNumberControls).toBeVisible();
    const metrics = await this.tagEditor.readAutoNumberResponsiveMetrics();
    expect(metrics.pageOverflows).toBe(false);
    for (const item of [metrics.controls, metrics.cancel, metrics.apply]) {
      expect(item.left).toBeGreaterThanOrEqual(metrics.footer.left - 1);
      expect(item.right).toBeLessThanOrEqual(metrics.footer.right + 1);
      expect(item.top).toBeGreaterThanOrEqual(metrics.footer.top - 1);
      expect(item.bottom).toBeLessThanOrEqual(metrics.footer.bottom + 1);
    }
    expect(metrics.footer.left).toBeGreaterThanOrEqual(metrics.dialog.left - 1);
    expect(metrics.footer.right).toBeLessThanOrEqual(metrics.dialog.right + 1);
  }

  async autoNumber() {
    await expect(this.tagEditor.autoNumberButton).toBeEnabled();
    await this.tagEditor.autoNumberButton.click();
  }

  async expectAutoNumberStartRejected(startAt) {
    await this.setAutoNumberStart(startAt);
    await this.autoNumber();
    await this.expectAutoNumberToggleState(false);
    await this.expectPendingChanges([]);
  }

  async expectAutoNumberToggleState(active) {
    await expect(this.tagEditor.autoNumberButton).toHaveAttribute(
      'aria-pressed',
      active ? 'true' : 'false',
    );
    // parity-check: allow-read-only-measurement-evaluate -- compare the rendered neutral and selected button treatments
    return this.tagEditor.autoNumberButton.evaluate(
      (button) => window.getComputedStyle(button).backgroundColor,
    );
  }

  async expectPendingChanges(filenames) {
    const expectedFilenames = new Set(filenames);
    for (const filename of await this.tagEditor.trackTitles.allTextContents()) {
      const normalizedFilename = String(filename || '').trim();
      await expect(this.tagEditor.pendingMarkerForTrack(normalizedFilename)).toHaveCount(
        expectedFilenames.has(normalizedFilename) ? 1 : 0,
      );
    }
    if (expectedFilenames.size > 0) {
      await expect(this.tagEditor.applyButton).toBeEnabled();
      await expect(this.tagEditor.applyButton).toHaveCSS('cursor', 'pointer');
      await expect(this.tagEditor.applyButton).toHaveCSS('opacity', '1');
      await expect(this.tagEditor.applyButton).toHaveCSS(
        'background-color',
        'rgba(239, 68, 68, 0.12)',
      );
    } else {
      await expect(this.tagEditor.applyButton).toBeDisabled();
      await expect(this.tagEditor.applyButton).toHaveCSS('cursor', 'not-allowed');
      await expect(this.tagEditor.applyButton).toHaveCSS('opacity', '0.55');
      await expect(this.tagEditor.applyButton).toHaveCSS(
        'background-color',
        'rgb(55, 65, 81)',
      );
      await expect(this.tagEditor.applyButton).toHaveCSS('color', 'rgb(148, 163, 184)');
    }
  }

  async readTrackNumberAndDiscByFilename(filename) {
    await this.selectTrackByFilename(filename);
    return {
      discNumber: String(await this.tagEditor.discNumberInput.inputValue()).trim(),
      trackNumber: String(await this.tagEditor.trackNumberInput.inputValue()).trim(),
    };
  }

  async setException(exceptionType) {
    await this.tagEditor.exceptionSelect.selectOption({ label: exceptionType });
    await expect(this.tagEditor.exceptionSelect).toHaveValue(exceptionType);
  }

  async clearException() {
    await this.tagEditor.exceptionSelect.selectOption({ label: 'None' });
    await expect(this.tagEditor.exceptionSelect).toHaveValue('');
  }

  async expectNonAlbumRarityConfirmationThenCancel() {
    let editRequestCount = 0;
    const observeEditRequest = (request) => {
      if (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/utilities/edit-tags'
      ) editRequestCount += 1;
    };
    this.tagEditor.page.on('request', observeEditRequest);
    try {
      await this.tagEditor.applyButton.click();
      await expect(this.tagEditor.confirmDialog).toBeVisible();
      await expect(this.tagEditor.nonAlbumRarityWarningText).toHaveText(
        'Applying non-album rarity exception to this track will remove it from the album. You sure?',
      );
      await expect(this.tagEditor.nonAlbumRarityWarningIcon).toHaveText('!');
      expect(editRequestCount).toBe(0);
      await this.tagEditor.confirmCancelButton.click();
      await expect(this.tagEditor.confirmOverlay).toBeHidden();
      await expect(this.tagEditor.overlay).toBeVisible();
    } finally {
      this.tagEditor.page.off('request', observeEditRequest);
    }
  }

  async close(options = {}) {
    const timeout = options.timeout || 30000;
    await this.tagEditor.cancelButton.click();
    await expect(this.tagEditor.overlay).toBeHidden({ timeout });
  }

  async dismissTopmostOverlayWithEscape() {
    await this.tagEditor.page.keyboard.press('Escape');
  }

  async gestureOnBackdrop() {
    await expect(this.tagEditor.overlay).toBeVisible();
    const point = await this.tagEditor.readBackdropGesturePoint();
    await this.tagEditor.page.mouse.move(point.x, point.y);
    await this.tagEditor.page.mouse.down();
    await this.tagEditor.page.mouse.up();
  }

  async waitForClosed(options = {}) {
    await expect(this.tagEditor.overlay).toBeHidden({
      timeout: options.timeout || 30000,
    });
  }

  async applyAndWaitForFailure(options = {}) {
    const timeout = options.timeout || 60000;
    const editResponsePromise = this.tagEditor.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/edit-tags'
    ), { timeout });
    await this.tagEditor.applyButton.click();
    await expect(this.tagEditor.confirmDialog).toBeVisible({ timeout });
    if (options.expectNonAlbumRarityWarning === true) {
      await expect(this.tagEditor.nonAlbumRarityWarningText).toHaveText(
        'Applying non-album rarity exception to this track will remove it from the album. You sure?',
        { timeout },
      );
      await expect(this.tagEditor.nonAlbumRarityWarningIcon).toHaveText('!');
      await expect(this.tagEditor.nonAlbumRarityWarningIcon).toHaveCSS(
        'color',
        'rgb(250, 204, 21)',
      );
    }
    await this.tagEditor.confirmButton.click();
    const response = await editResponsePromise;
    const payload = await response.json();
    expect(response.ok()).toBe(false);
    expect(payload?.ok).not.toBe(true);
    await expect(this.tagEditor.overlay).toBeHidden({ timeout });
    await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout });
    await expect(this.tagEditor.repairAlert).toBeVisible({ timeout });
    await expect(this.tagEditor.repairAlert).toHaveClass(/has-log-history-link/u, { timeout });
    await expect(this.tagEditor.repairAlertLogHistory).toBeVisible({ timeout });
    const alertText = String(await this.tagEditor.repairAlertMessage.textContent() || '').trim();
    if (options.expectedErrorPattern) {
      expect(alertText).toMatch(options.expectedErrorPattern);
    }
    return { alertText, payload, status: response.status() };
  }

  async readFailureAlertPresentation() {
    const selectors = {
      link: this.tagEditor.repairAlertLogHistorySelector,
      message: this.tagEditor.repairAlertMessageSelector,
    };
    // parity-check: allow-read-only-measurement-evaluate -- inspect computed alert presentation only
    return this.tagEditor.repairAlert.evaluate((alert, ownedSelectors) => {
      const message = alert.querySelector(ownedSelectors.message);
      const link = alert.querySelector(ownedSelectors.link);
      const alertRect = alert.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const style = getComputedStyle(message);
      return {
        alertCenterOffsetPx: Math.abs((alertRect.left + (alertRect.width / 2)) - (viewportWidth / 2)),
        alertTopPx: alertRect.top,
        alertText: String(alert.textContent || '').trim(),
        linkText: String(link?.textContent || '').trim(),
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    }, selectors);
  }

  async openLogHistoryFromFailure(options = {}) {
    await expect(this.tagEditor.repairAlertLogHistory).toBeVisible({
      timeout: options.timeout || 30000,
    });
    await this.tagEditor.repairAlertLogHistory.click();
  }

  async applyAndWaitForAsyncFailure(options = {}) {
    const timeout = options.timeout || 60000;
    const saveTaskStatuses = new Map();
    const observeSaveTask = async (response) => {
      const responseUrl = new URL(response.url());
      const match = responseUrl.pathname.match(/^\/utilities\/save-task\/([^/]+)$/);
      if (!match || response.request().method() !== 'GET') return;
      try {
        saveTaskStatuses.set(decodeURIComponent(match[1]), await response.json());
      } catch (error) {
        saveTaskStatuses.set(decodeURIComponent(match[1]), {
          status: 'invalid-response',
          error: error?.message || String(error),
        });
      }
    };
    this.tagEditor.page.on('response', observeSaveTask);
    try {
      const editResponsePromise = this.tagEditor.page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/utilities/edit-tags'
      ), { timeout });
      await this.tagEditor.applyButton.click();
      await expect(this.tagEditor.confirmDialog).toBeVisible({ timeout });
      await this.tagEditor.confirmButton.click();
      const response = await editResponsePromise;
      const payload = await response.json();
      if (!response.ok() || payload?.ok !== true) {
        return this.readTerminalEditFailure({ payload, response, timeout });
      }
      const saveTaskId = String(payload.save_task_id || '').trim();
      if (!saveTaskId) {
        throw new Error('Accepted tag edit did not return a save_task_id.');
      }
      let failedTask = null;
      await expect.poll(() => {
        const task = saveTaskStatuses.get(saveTaskId) || null;
        if (task?.status === 'invalid-response') {
          throw new Error(
            `Save task ${saveTaskId} returned invalid JSON: ${task.error || 'unknown error'}`,
          );
        }
        if (task?.status === 'completed') {
          throw new Error(`Expected save task ${saveTaskId} to fail, but it completed.`);
        }
        if (task?.status === 'failed') failedTask = task;
        return task?.status || '';
      }, {
        message: `Expected save task ${saveTaskId} to fail through the production poller.`,
        timeout,
        intervals: [250, 500, 750, 1000],
      }).toBe('failed');
      await expect(this.tagEditor.overlay).toBeHidden({ timeout });
      await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout });
      await expect(this.tagEditor.repairAlert).toBeVisible({ timeout });
      const failedTaskError = String(failedTask?.error || '').trim();
      if (!failedTaskError) {
        throw new Error(`Failed save task ${saveTaskId} did not include an error.`);
      }
      await expect(this.tagEditor.repairAlertMessage).toContainText(
        failedTaskError,
        { timeout },
      );
      return {
        alertText: String(
          await this.tagEditor.repairAlertMessage.textContent() || '',
        ).trim(),
        editPayload: payload,
        task: failedTask,
      };
    } finally {
      this.tagEditor.page.off('response', observeSaveTask);
    }
  }

  async readTerminalEditFailure({ payload, response, timeout }) {
    const saveTaskId = String(payload?.save_task_id || '').trim();
    const failureError = String(payload?.error || '').trim();
    if (
      payload?.save_task_status !== 'failed'
      || !saveTaskId
      || !failureError
    ) {
      throw new Error(
        `Tag edit was not terminally failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    await expect(this.tagEditor.overlay).toBeHidden({ timeout });
    await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout });
    await expect(this.tagEditor.repairAlert).toBeVisible({ timeout });
    await expect(this.tagEditor.repairAlertMessage).toHaveText(
      'Failed to edit tags.',
      { timeout },
    );
    return {
      alertText: String(
        await this.tagEditor.repairAlertMessage.textContent() || '',
      ).trim(),
      editPayload: payload,
      task: {
        error: failureError,
        id: saveTaskId,
        status: 'failed',
      },
    };
  }

  async applyAndWaitForSavedFiles(options = {}) {
    const timeout = options.timeout || 60000;
    const saveTaskStatuses = new Map();
    let editRequestCount = 0;
    const observeEditRequest = (request) => {
      if (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/utilities/edit-tags'
      ) {
        editRequestCount += 1;
      }
    };
    const observeSaveTask = async (response) => {
      const responseUrl = new URL(response.url());
      const match = responseUrl.pathname.match(/^\/utilities\/save-task\/([^/]+)$/);
      if (!match || response.request().method() !== 'GET') return;
      try {
        saveTaskStatuses.set(decodeURIComponent(match[1]), await response.json());
      } catch (error) {
        saveTaskStatuses.set(decodeURIComponent(match[1]), {
          status: 'invalid-response',
          error: error?.message || String(error),
        });
      }
    };
    this.tagEditor.page.on('request', observeEditRequest);
    this.tagEditor.page.on('response', observeSaveTask);
    try {
      const editResponsePromise = this.tagEditor.page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/utilities/edit-tags'
      ), { timeout });
      await this.tagEditor.applyButton.click();
      await expect(this.tagEditor.confirmDialog).toBeVisible({ timeout });
      if (options.expectNonAlbumRarityWarning === true) {
        await expect(this.tagEditor.nonAlbumRarityWarningText).toHaveText(
          'Applying non-album rarity exception to this track will remove it from the album. You sure?',
          { timeout },
        );
        await expect(this.tagEditor.nonAlbumRarityWarningIcon).toHaveText('!');
        await expect(this.tagEditor.nonAlbumRarityWarningIcon).toHaveCSS(
          'color',
          'rgb(250, 204, 21)',
        );
        if (editRequestCount !== 0) {
          throw new Error(
            `Expected the non-album rarity confirmation to send no edit request before acceptance; observed ${editRequestCount}.`,
          );
        }
      }
      await this.tagEditor.confirmButton.click();
      const response = await editResponsePromise;
      const payload = await response.json();
      if (!response.ok() || payload?.ok !== true) {
        throw new Error(
          `Tag edit failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
        );
      }
      const saveTaskId = String(payload.save_task_id || '').trim();
      if (options.terminalAlertDismissalTimeout) {
        expect(saveTaskId).not.toBe('');
        expect(payload.save_task_status).toBe('completed');
      }
      if (saveTaskId) {
        const responseTaskCompleted = String(payload.save_task_status || '') === 'completed';
        if (!responseTaskCompleted) {
          await expect.poll(() => {
            const task = saveTaskStatuses.get(saveTaskId) || null;
            if (task?.status === 'failed') {
              throw new Error(task.error || `Save task ${saveTaskId} failed.`);
            }
            if (task?.status === 'invalid-response') {
              throw new Error(
                `Save task ${saveTaskId} returned invalid JSON: ${task.error || 'unknown error'}`,
              );
            }
            return task?.status || '';
          }, {
            message: `Expected save task ${saveTaskId} to finish through the production poller.`,
            timeout,
            intervals: [250, 500, 750, 1000],
          }).toBe('completed');
        }
        if (typeof options.onSaveTaskCompleted === 'function') {
          await options.onSaveTaskCompleted({
            editPayload: payload,
            saveTaskId,
            task: responseTaskCompleted ? payload : saveTaskStatuses.get(saveTaskId),
          });
        }
        await expect(this.tagEditor.repairAlertMessage).toHaveText(
          responseTaskCompleted
            ? 'Tag changes saved.'
            : 'Library view updated from saved files.',
          { timeout },
        );
        await expect(this.tagEditor.repairAlert).toBeVisible({ timeout });
        if (options.terminalAlertDismissalTimeout) {
          await expect(this.tagEditor.repairAlert).toBeHidden({
            timeout: Number(options.terminalAlertDismissalTimeout),
          });
        }
      }
      await expect(this.tagEditor.overlay).toBeHidden({ timeout });
      await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout });
      return payload;
    } finally {
      this.tagEditor.page.off('request', observeEditRequest);
      this.tagEditor.page.off('response', observeSaveTask);
    }
  }

  async applyAndReturnAcceptedEdit(options = {}) {
    const timeout = options.timeout || 60000;
    const editResponsePromise = this.tagEditor.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/edit-tags'
    ), { timeout });
    await this.tagEditor.applyButton.click();
    await expect(this.tagEditor.confirmDialog).toBeVisible({ timeout });
    const confirmationClickedAt = performance.now();
    const confirmClickPromise = this.tagEditor.confirmButton.click();
    const beforeResponsePromise = typeof options.onBeforeResponse === 'function'
      ? options.onBeforeResponse({ confirmationClickedAt })
      : Promise.resolve();
    await confirmClickPromise;
    await beforeResponsePromise;
    const response = await editResponsePromise;
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true) {
      throw new Error(
        `Tag edit failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    const saveTaskId = String(payload.save_task_id || '').trim();
    expect(saveTaskId).not.toBe('');
    expect(payload.save_task_status).toBe('completed');
    await expect(this.tagEditor.overlay).toBeHidden({ timeout });
    await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout });
    const acceptedAt = performance.now();
    const terminalSavedAlert = this.tagEditor.repairAlertMessage;
    return {
      acceptedAt,
      clickToAcceptedMs: acceptedAt - confirmationClickedAt,
      payload,
      saveTaskId,
      waitForCompletion: async (waitOptions = {}) => {
        const completionTimeout = waitOptions.timeout || timeout;
        await expect(terminalSavedAlert).toHaveText(
          'Tag changes saved.',
          { timeout: completionTimeout },
        );
        await expect(this.tagEditor.overlay).toBeHidden({ timeout: completionTimeout });
        await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout: completionTimeout });
        return payload;
      },
    };
  }

  async applyAndWaitForTerminalSavedResponse(options = {}) {
    const timeout = options.timeout || 35000;
    let saveTaskPollCount = 0;
    let postSettled = false;
    const observesNotificationLifecycle = (
      typeof this.tagEditor.startRepairAlertLifecycleObservation === 'function'
    );
    let notificationObservation = observesNotificationLifecycle
      ? await this.tagEditor.startRepairAlertLifecycleObservation()
      : { async finish() { return []; } };
    const observeSaveTaskPoll = (request) => {
      if (
        request.method() === 'GET'
        && /^\/utilities\/save-task(?:\/|$)/.test(new URL(request.url()).pathname)
      ) {
        saveTaskPollCount += 1;
      }
    };
    this.tagEditor.page.on('request', observeSaveTaskPoll);
    try {
      const editResponsePromise = this.tagEditor.page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/utilities/edit-tags'
      ), { timeout }).finally(() => { postSettled = true; });
      await this.tagEditor.applyButton.click();
      await expect(this.tagEditor.confirmDialog).toBeVisible({ timeout });
      await this.tagEditor.confirmButton.click();
      await expect(this.tagEditor.repairAlertMessage).toHaveText(
        'Writing tag changes...',
        { timeout },
      );
      await expect(this.tagEditor.repairAlert).toBeVisible({ timeout });
      if (typeof options.whilePostInFlight === 'function') {
        expect(postSettled).toBe(false);
        await options.whilePostInFlight({ isPostSettled: () => postSettled });
      }
      const response = await editResponsePromise;
      const payload = await response.json();
      if (!response.ok() || payload?.ok !== true) {
        throw new Error(
          `Tag edit failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
        );
      }
      const saveTaskId = String(payload.save_task_id || '').trim();
      expect(saveTaskId).not.toBe('');
      expect(payload.save_task_status).toBe('completed');

      await expect(this.tagEditor.overlay).toBeHidden({ timeout });
      await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout });
      await expect(this.tagEditor.repairAlertMessage).toHaveText('Tag changes saved.', { timeout });
      await expect(this.tagEditor.repairAlert).toBeVisible({ timeout });
      const notificationSamples = await notificationObservation.finish();
      notificationObservation = null;
      const visibleSamples = notificationSamples.filter((sample) => sample.visible);
      expect(visibleSamples.some((sample) => (
        sample.text === 'Writing tag changes...'
      ))).toBe(true);
      expect(visibleSamples.filter((sample) => sample.error)).toEqual([]);
      expect(visibleSamples.some((sample) => (
        sample.text === 'Tag changes queued. Finalizing library view...'
        || sample.text === 'Library view updated from saved files.'
      ))).toBe(false);
      expect(visibleSamples.some((sample) => (
        sample.text === 'Tag changes saved.'
      ))).toBe(true);
      expect(saveTaskPollCount).toBe(0);
      return { notificationSamples, payload, saveTaskId };
    } finally {
      this.tagEditor.page.off('request', observeSaveTaskPoll);
      if (notificationObservation) await notificationObservation.finish();
    }
  }

  async applyAndObserveOptimisticState(options = {}) {
    const timeout = options.timeout || 60000;
    const expectedField = String(options.expectedField || '').trim();
    const expectedValue = String(options.expectedValue || '').trim();
    const expectedFilenames = (
      Array.isArray(options.expectedFilenames)
        ? options.expectedFilenames
        : [options.expectedFilename]
    ).map((filename) => String(filename || '').trim()).filter(Boolean);
    if (!expectedField || !expectedValue || !expectedFilenames.length) {
      throw new Error(
        'Optimistic tag-edit observation requires expectedField, expectedValue, and expected filename(s).',
      );
    }
    if (typeof options.readOptimisticState !== 'function') {
      throw new Error('Optimistic tag-edit observation requires readOptimisticState.');
    }

    let saveTaskPollCount = 0;
    const observesNotificationLifecycle = (
      typeof this.tagEditor.startRepairAlertLifecycleObservation === 'function'
    );
    let notificationObservation = observesNotificationLifecycle
      ? await this.tagEditor.startRepairAlertLifecycleObservation()
      : { async finish() { return []; } };
    const observeSaveTaskPoll = (request) => {
      if (
        request.method() === 'GET'
        && /^\/utilities\/save-task(?:\/|$)/.test(new URL(request.url()).pathname)
      ) {
        saveTaskPollCount += 1;
      }
    };
    this.tagEditor.page.on('request', observeSaveTaskPoll);
    try {
      const editRequestPromise = this.tagEditor.page.waitForRequest((request) => (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/utilities/edit-tags'
      ), { timeout });
      const editResponsePromise = this.tagEditor.page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/utilities/edit-tags'
      ), { timeout });
      await this.tagEditor.applyButton.click();
      await expect(this.tagEditor.confirmDialog).toBeVisible({ timeout });
      const confirmationClickedAt = performance.now();
      await this.tagEditor.confirmButton.click();
      const terminalResponseOutcomePromise = editResponsePromise
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok() || payload?.ok !== true) {
            throw new Error(
              `Tag edit failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
            );
          }
          const saveTaskId = String(payload.save_task_id || '').trim();
          expect(saveTaskId).not.toBe('');
          expect(payload.save_task_status).toBe('completed');
          const retainedOptimisticState = await options.readOptimisticState(
            'after-terminal-response',
          );
          return { payload, retainedOptimisticState, saveTaskId };
        })
        .then(
          (value) => ({ error: null, value }),
          (error) => ({ error, value: null }),
        );
      const optimisticState = await options.readOptimisticState(
        'before-edit-response',
      );
      const optimisticObservedAt = performance.now();
      const request = await editRequestPromise;
      const requestBody = request.postDataJSON();
      expect(Object.keys(requestBody || {}).sort()).toEqual([
        'album',
        'confirmed',
        'updates',
      ]);
      expect(requestBody.confirmed).toBe(true);
      const updateEntries = Object.entries(requestBody.updates || {});
      expect(updateEntries).toHaveLength(expectedFilenames.length);
      const expectedFilenameSet = new Set(expectedFilenames);
      for (const [editedPath, sparseUpdates] of updateEntries) {
        const normalizedEditedPath = editedPath.replaceAll('\\', '/');
        const matchingFilename = expectedFilenames.find(
          (filename) => normalizedEditedPath.endsWith(`/${filename}`),
        );
        expect(matchingFilename).toBeDefined();
        expectedFilenameSet.delete(matchingFilename);
        expect(sparseUpdates).toEqual({ [expectedField]: expectedValue });
      }
      expect(expectedFilenameSet.size).toBe(0);

      const terminalResponseOutcome = await terminalResponseOutcomePromise;
      if (terminalResponseOutcome.error) {
        throw terminalResponseOutcome.error;
      }
      const { payload, retainedOptimisticState } = terminalResponseOutcome.value;
      await expect(this.tagEditor.repairAlertMessage).toHaveText(
        'Tag changes saved.',
        { timeout },
      );
      await expect(this.tagEditor.overlay).toBeHidden({ timeout });
      await expect(this.tagEditor.confirmOverlay).toBeHidden({ timeout });
      const notificationSamples = await notificationObservation.finish();
      notificationObservation = null;
      const visibleSamples = notificationSamples.filter((sample) => sample.visible);
      const legacyLibraryRefreshAlert = [
        'Library view updated',
        'from saved files.',
      ].join(' ');
      if (observesNotificationLifecycle) {
        expect(visibleSamples.some((sample) => sample.text === 'Writing tag changes...')).toBe(true);
        expect(visibleSamples.some((sample) => sample.text === 'Tag changes saved.')).toBe(true);
        expect(visibleSamples.filter((sample) => sample.error)).toEqual([]);
        expect(visibleSamples.some((sample) => (
          sample.text === 'Tag changes queued. Finalizing library view...'
          || sample.text === legacyLibraryRefreshAlert
        ))).toBe(false);
      }
      expect(saveTaskPollCount).toBe(0);
      const completedState = typeof options.readCompletedState === 'function'
        ? await options.readCompletedState('after-save-completion')
        : null;
      return {
        clickToOptimisticMs: optimisticObservedAt - confirmationClickedAt,
        completedState,
        optimisticState,
        retainedOptimisticState,
        notificationSamples,
        payload,
        requestBody,
      };
    } finally {
      this.tagEditor.page.off('request', observeSaveTaskPoll);
      if (notificationObservation) await notificationObservation.finish();
    }
  }
}
