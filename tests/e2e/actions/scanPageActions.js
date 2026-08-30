import { expect } from '@playwright/test';

export class ScanPageActions {
  constructor(scanPage) {
    this.scanPage = scanPage;
  }

  async waitForVisible(options = {}) {
    await this.scanPage.waitForVisible(this.scanPage.loader, { timeout: options.timeout || 30000 });
  }

  async waitForHidden(options = {}) {
    await this.scanPage.waitForHidden(this.scanPage.loader, { timeout: options.timeout || 30000 });
  }

  async waitForDedicatedPageVisible(options = {}) {
    const timeout = options.timeout || 30000;
    await this.waitForVisible({ timeout });
    await expect(this.scanPage.backButton).toBeVisible({ timeout });
  }

  async waitForDedicatedPageHidden(options = {}) {
    const timeout = options.timeout || 30000;
    await this.scanPage.waitForPageCondition((selectors) => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement) || element.hidden) return false;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.visibility !== 'collapse'
          && Number(style.opacity || 1) > 0
          && bounds.width > 0
          && bounds.height > 0;
      };
      return selectors.every((selector) => !isVisible(document.querySelector(selector)));
    }, { timeout }, [
      this.scanPage.loaderSelector,
      this.scanPage.backButtonSelector,
      this.scanPage.cancelButtonSelector,
      this.scanPage.browseButtonSelector,
    ]);
  }

  async expectDedicatedScanActions(expectedCancelLabel, options = {}) {
    const timeout = options.timeout || 30000;
    await expect(this.scanPage.actions).toBeVisible({ timeout });
    await expect(this.scanPage.cancelButton).toBeVisible({ timeout });
    await expect(this.scanPage.cancelButton).toHaveText(expectedCancelLabel, { timeout });
    await expect(this.scanPage.browseButton).toBeVisible({ timeout });
    await expect(this.scanPage.browseButton).toHaveText('Browse Library', { timeout });

    const presentation = await this.scanPage.readActionPresentation();
    expect(presentation.cancelBounds).not.toBeNull();
    expect(presentation.browseBounds).not.toBeNull();
    expect(
      presentation.cancelBounds.x + presentation.cancelBounds.width,
      'Cancel must render to the left of Browse Library.',
    ).toBeLessThanOrEqual(presentation.browseBounds.x);
    expect(presentation.cancelStyle.backgroundColor).toBe('rgba(127, 29, 29, 0.62)');
    expect(presentation.cancelStyle.borderColor).toBe('rgba(239, 68, 68, 0.65)');
    expect(presentation.browseStyle.backgroundColor)
      .not.toBe(presentation.cancelStyle.backgroundColor);
  }

  async cancelActiveScan(expectedCancelLabel, options = {}) {
    const timeout = options.timeout || 30000;
    let cancelRequestCount = 0;
    const observeCancelRequest = (request) => {
      if (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/cancel-refresh-api'
      ) {
        cancelRequestCount += 1;
      }
    };
    this.scanPage.page.on('request', observeCancelRequest);
    try {
      await expect(this.scanPage.cancelButton).toHaveText(expectedCancelLabel, { timeout });
      const cancelResponsePromise = this.scanPage.page.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/cancel-refresh-api'
      ));
      await this.scanPage.cancelButton.click();
      const cancelResponse = await cancelResponsePromise;
      expect(cancelResponse.ok()).toBe(true);
      const cancelPayload = await cancelResponse.json();
      expect(cancelPayload.ok).toBe(true);
      expect(cancelPayload.cancelled).toBe(true);
      await this.waitForPhaseTitle('No Active Scan Running', { timeout });
      await expect(this.scanPage.cancelButton).toBeHidden({ timeout });
      expect(cancelRequestCount).toBe(1);
    } finally {
      this.scanPage.page.off('request', observeCancelRequest);
    }
  }

  async expectCancelAbsent(options = {}) {
    await expect(this.scanPage.cancelButton).toBeHidden({
      timeout: options.timeout || 10000,
    });
  }

  async waitForBrowseButton(options = {}) {
    await this.scanPage.waitForVisible(this.scanPage.browseButton, { timeout: options.timeout || 60000 });
  }

  async clickBrowseScannedLibrary() {
    await this.scanPage.browseButton.click();
  }

  async waitForDiscoveryVisible(options = {}) {
    await this.scanPage.waitForVisible(this.scanPage.discoveryText, {
      timeout: options.timeout || 60000,
    });
  }

  async waitForIndexingVisible(options = {}) {
    await this.scanPage.waitForPageCondition((selectors) => {
      const status = document.querySelector(selectors.statusSelector);
      const progressLines = Array.from(document.querySelectorAll(selectors.progressLineSelector));
      const statusText = (status?.textContent || '').trim().toLowerCase();
      const hasProcessedLine = progressLines.some((line) => {
        const text = (line.textContent || '').toLowerCase();
        return text.includes('processed') || text.includes('elapsed') || text.includes('album folders');
      });
      return statusText.includes('scanning music files') || hasProcessedLine;
    }, {
      timeout: options.timeout || 60000,
    }, {
      statusSelector: this.scanPage.statusSelector,
      progressLineSelector: this.scanPage.progressLineSelector,
    });
  }

  async waitForPhaseTitle(expectedTitle, options = {}) {
    await expect(this.scanPage.title).toHaveText(String(expectedTitle || '').trim(), {
      timeout: options.timeout || 60000,
    });
  }

  async expectBrowseContextCleared(options = {}) {
    const timeout = options.timeout || 10000;
    await expect(this.scanPage.searchInput).toHaveValue('', { timeout });
    await expect(this.scanPage.activeSidebarSelection).toBeHidden({ timeout });
    await expect(this.scanPage.artistFamilyPanel).toBeHidden({ timeout });
    await expect(this.scanPage.gallery).toBeHidden({ timeout });
  }

  async clickBack() {
    await this.scanPage.backButton.click();
  }

  startBrowseContinuityObservation() {
    return this.scanPage.startBrowseContinuityObservation();
  }

  readPerformanceNow() {
    // parity-check: allow-read-only-measurement-evaluate -- capture the browser clock used by the atomic readiness observer
    return this.scanPage.page.evaluate(() => performance.now());
  }

  waitForSearchReadiness(expected, options = {}) {
    return this.scanPage.waitForSearchReadiness(expected, options);
  }

  startGalleryExitObservation(options = {}) {
    return this.scanPage.startGalleryExitObservation(options);
  }

  async finishGalleryExitObservation(observation, options = {}) {
    const result = await observation.finish(options.settleMs || 500);
    if (options.testInfo && result) {
      await options.testInfo.attach(options.attachmentName || 'temporary-scan-gallery-exit-diagnostics', {
        body: Buffer.from(JSON.stringify(result, null, 2)),
        contentType: 'application/json',
      });
    }
    expect(result).not.toBeNull();
    expect(
      result.firstReadyMs,
      `Scan Page exit never reached a fully rendered top-of-gallery state: ${JSON.stringify(result)}`,
    ).not.toBeNull();
    expect(
      result.invalidSamples,
      `Gallery regressed after becoming ready: ${JSON.stringify(result.invalidSamples)}`,
    ).toEqual([]);
    expect(result.sampleCount).toBeGreaterThan(1);
    expect(result.finalSample.loaderVisible).toBe(false);
    expect(result.finalSample.galleryVisible).toBe(true);
    expect(result.finalSample.scrollTop).toBe(0);
    expect(result.finalSample.headings.length).toBeGreaterThan(0);
    expect(result.finalSample.cards.length).toBeGreaterThan(0);
    expect(
      result.finalSample.cards.every((card) => (
        Boolean(card.albumKey && card.title && card.coverSettled)
      )),
      `Every visible retained gallery card must keep its required settled cover state: ${JSON.stringify(result.finalSample.cards)}`,
    ).toBe(true);
    return result;
  }

  startPhaseObservation() {
    return this.scanPage.startPhaseObservation();
  }

  async captureRelationshipRefreshActions(path, options = {}) {
    await this.scanPage.waitForPageCondition((selectors) => {
      const visible = (element) => {
        if (!(element instanceof HTMLElement) || element.hidden) return false;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && bounds.width > 0
          && bounds.height > 0;
      };
      const loaderCopy = [
        String(document.querySelector(selectors.titleSelector)?.textContent || '').trim(),
        ...Array.from(document.querySelectorAll(selectors.progressTitleSelector))
          .map((title) => String(title.textContent || '').trim()),
      ].join(' ');
      return /artist famil|artist relation|relationship/i.test(loaderCopy)
        && visible(document.querySelector(selectors.cancelButtonSelector))
        && visible(document.querySelector(selectors.browseButtonSelector));
    }, {
      timeout: options.timeout || 120000,
    }, {
      browseButtonSelector: this.scanPage.browseButtonSelector,
      cancelButtonSelector: this.scanPage.cancelButtonSelector,
      progressTitleSelector: `${this.scanPage.progressLineSelector} ${this.scanPage.progressTitleSelector}`,
      titleSelector: this.scanPage.titleSelector,
    });
    await this.scanPage.page.screenshot({
      path,
      fullPage: options.fullPage !== false,
    });
  }

  expectPhaseObservation(observation) {
    const titles = Array.isArray(observation?.titles) ? observation.titles : [];
    expect(titles).toContain('Discovering music files');
    expect(titles).toContain('Scanning music files');
    expect(titles).toContain('Updating cover art');
    expect(titles).toContain('No Active Scan Running');
    expect(titles.some((title) => /artist famil|relation/i.test(title))).toBe(true);
    const relationActionSamples = Array.isArray(observation?.relationActionSamples)
      ? observation.relationActionSamples
      : [];
    expect(relationActionSamples.length).toBeGreaterThan(0);
    expect(
      relationActionSamples.every((sample) => sample.cancelVisible && sample.browseVisible),
      `Cancel and Browse must stay visible through relationship refresh: ${JSON.stringify(relationActionSamples)}`,
    ).toBe(true);
  }

  async readBrowseContext() {
    const activeSelection = await this.scanPage.activeSidebarSelection.count() === 1
      ? String(
        await this.scanPage.activeSidebarSelection.getAttribute('data-sidebar-artist')
        || await this.scanPage.activeSidebarSelection.getAttribute('data-sidebar-all-artists')
        || '',
      ).trim()
      : '';
    return {
      activeSelection,
      artistFamilyTitle: await this.scanPage.artistFamilyPanel.isVisible()
        ? String(await this.scanPage.artistFamilyTitle.textContent() || '').trim()
        : '',
      artistFamilyVisible: await this.scanPage.artistFamilyPanel.isVisible(),
      galleryHeadings: (await this.scanPage.galleryHeadings.allTextContents())
        .map((heading) => String(heading || '').trim())
        .filter(Boolean),
      galleryVisible: await this.scanPage.gallery.isVisible(),
      hasVisibleCover: await this.scanPage.galleryCoverStates.first().isVisible(),
      query: String(await this.scanPage.searchInput.inputValue() || ''),
      url: this.scanPage.page.url(),
    };
  }

  async waitForBrowseContext(expected, options = {}) {
    await this.scanPage.waitForPageCondition((selectors) => {
      const activeSelectionNode = document.querySelector(selectors.activeSidebarSelectionSelector);
      const activeSelection = activeSelectionNode instanceof HTMLElement
        ? String(
          activeSelectionNode.getAttribute('data-sidebar-artist')
          || activeSelectionNode.getAttribute('data-sidebar-all-artists')
          || '',
        ).trim()
        : '';
      const familyPanel = document.querySelector(selectors.artistFamilyPanelSelector);
      const familyVisible = familyPanel instanceof HTMLElement
        && !familyPanel.hidden
        && getComputedStyle(familyPanel).display !== 'none'
        && getComputedStyle(familyPanel).visibility !== 'hidden';
      const familyTitle = familyVisible
        ? String(familyPanel.querySelector(selectors.artistFamilyTitleSelector)?.textContent || '').trim()
        : '';
      const gallery = document.querySelector(selectors.gallerySelector);
      const galleryVisible = gallery instanceof HTMLElement
        && !gallery.hidden
        && getComputedStyle(gallery).display !== 'none'
        && getComputedStyle(gallery).visibility !== 'hidden';
      const galleryHeadings = Array.from(
        document.querySelectorAll(selectors.galleryHeadingSelector),
      ).map((heading) => String(heading.textContent || '').trim()).filter(Boolean);
      const cover = document.querySelector(selectors.galleryCoverStateSelector);
      const hasVisibleCover = cover instanceof HTMLElement
        && !cover.hidden
        && getComputedStyle(cover).display !== 'none'
        && getComputedStyle(cover).visibility !== 'hidden';
      const query = String(
        document.querySelector(selectors.searchInputSelector)?.value || '',
      );
      return activeSelection === selectors.expected.activeSelection
        && familyTitle === selectors.expected.artistFamilyTitle
        && familyVisible === selectors.expected.artistFamilyVisible
        && galleryVisible === selectors.expected.galleryVisible
        && hasVisibleCover === selectors.expected.hasVisibleCover
        && selectors.expected.galleryHeadings.every(
          (heading) => galleryHeadings.includes(heading),
        )
        && query === selectors.expected.query
        && window.location.href === selectors.expected.url;
    }, {
      timeout: options.timeout || 60000,
    }, {
      activeSidebarSelectionSelector: this.scanPage.activeSidebarSelectionSelector,
      artistFamilyPanelSelector: this.scanPage.artistFamilyPanelSelector,
      artistFamilyTitleSelector: this.scanPage.artistFamilyTitleSelector,
      expected,
      galleryCoverStateSelector: this.scanPage.galleryCoverStateSelector,
      galleryHeadingSelector: this.scanPage.galleryHeadingSelector,
      gallerySelector: this.scanPage.gallerySelector,
      searchInputSelector: this.scanPage.searchInputSelector,
    });
  }

  async waitForElapsedTimer(options = {}) {
    await this.scanPage.waitForPageCondition((selectors) => {
      const progressLines = Array.from(document.querySelectorAll(selectors.progressLineSelector));
      return progressLines.some((line) => {
        const text = (line.textContent || '').trim();
        return /Elapsed/i.test(text) && !/0:00|0 seconds/i.test(text);
      });
    }, {
      timeout: options.timeout || 60000,
    }, {
      progressLineSelector: this.scanPage.progressLineSelector,
    });
  }

  async readSnapshot() {
    const progressLines = [];
    const progressLineCount = await this.scanPage.progressLines.count();
    for (let index = 0; index < progressLineCount; index += 1) {
      const line = this.scanPage.progressLines.nth(index);
      progressLines.push({
        title: String(await line.locator(this.scanPage.progressTitleSelector).textContent() || '').trim(),
        detail: String(await line.locator(this.scanPage.progressDetailSelector).textContent() || '').trim(),
        text: String(await line.textContent() || '').trim(),
      });
    }
    return {
      title: String(await this.scanPage.title.textContent() || '').trim(),
      status: String(await this.scanPage.status.textContent() || '').trim(),
      progressLines,
      browseButtonVisible: await this.scanPage.browseButton.isVisible(),
      browseButtonText: String(await this.scanPage.browseButton.textContent() || '').trim(),
    };
  }
}
