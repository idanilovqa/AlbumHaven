import { expect } from '@playwright/test';

export function isRetryableStatusProbeError(error) {
  const message = String(error?.message || error || '');
  return /(?:\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE)\b|socket hang up)/iu.test(message);
}

export class AppBarActions {
  constructor(appBar) {
    this.appBar = appBar;
  }

  async waitForVisible(options = {}) {
    await this.appBar.waitForVisible(this.appBar.toolbar, { timeout: options.timeout || 30000 });
  }

  async openStatusMenu(options = {}) {
    const timeout = options.timeout || 10000;
    await expect.poll(async () => {
      if (await this.appBar.statusContextMenu.isVisible()) return true;
      await this.appBar.scanIndicator.click({ button: 'right' });
      return this.appBar.statusContextMenu.isVisible();
    }, {
      timeout,
      intervals: [100, 250, 500],
      message: 'Expected the scan status context menu to open',
    }).toBe(true);
  }

  async waitForScanActionLabel(expectedLabel, options = {}) {
    await this.appBar.waitForPageCondition((selectors) => {
      const button = document.querySelector(selectors.scanActionButtonSelector);
      if (!(button instanceof HTMLElement)) return false;
      return (button.textContent || '').trim() === selectors.expectedLabel;
    }, {
      timeout: options.timeout || 10000,
    }, {
      scanActionButtonSelector: this.appBar.scanActionButtonSelector,
      expectedLabel,
    });
  }

  async readScanActionLabel() {
    return this.appBar.scanActionButton.textContent();
  }

  async triggerFullRescan() {
    await this.openStatusMenu();
    await this.appBar.scanActionButton.click();
  }

  async triggerIncrementalScan() {
    await this.appBar.scanIndicator.click();
  }

  async expectActiveCoverScanAction(options = {}) {
    await this.appBar.waitForPageCondition((selectors) => {
      const button = document.querySelector(selectors.coverActionButtonSelector);
      if (!(button instanceof HTMLButtonElement)) return false;
      const bounds = button.getBoundingClientRect();
      return !button.hidden
        && bounds.width > 0
        && bounds.height > 0
        && !button.disabled
        && (button.textContent || '').trim() === selectors.expectedLabel
        && button.getAttribute('data-status-action') === selectors.expectedAction;
    }, {
      timeout: options.timeout || 10000,
    }, {
      coverActionButtonSelector: this.appBar.coverActionButtonSelector,
      expectedLabel: 'Cancel Album Cover Scan',
      expectedAction: 'cancel-cover-scan',
    });
  }

  async triggerRepeatedIncrementalScanAndExpectAlreadyRunning(options = {}) {
    let refreshRequestCount = 0;
    const observeRefreshRequest = (request) => {
      if (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/refresh-api'
      ) {
        refreshRequestCount += 1;
      }
    };
    this.appBar.page.on('request', observeRefreshRequest);
    try {
      await this.triggerIncrementalScan();
      await expect(this.appBar.scanAlreadyRunningToast.filter({
        hasText: 'Library scan is already running.',
      })).toBeVisible({ timeout: options.timeout || 10000 });
      expect(refreshRequestCount).toBe(0);
      return { refreshRequestCount };
    } finally {
      this.appBar.page.off('request', observeRefreshRequest);
    }
  }

  async triggerBusyIncrementalScanAndExpectInert() {
    let refreshRequestCount = 0;
    const observeRefreshRequest = (request) => {
      if (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/refresh-api'
      ) {
        refreshRequestCount += 1;
      }
    };
    this.appBar.page.on('request', observeRefreshRequest);
    try {
      await this.triggerIncrementalScan();
      await expect(this.appBar.scanIndicator).toHaveClass(/(?:^|\s)is-busy(?:\s|$)/);
      expect(refreshRequestCount).toBe(0);
      await expect(this.appBar.scanAlreadyRunningToast.filter({
        hasText: 'Library scan is already running.',
      })).toBeHidden();
      return { refreshRequestCount };
    } finally {
      this.appBar.page.off('request', observeRefreshRequest);
    }
  }

  async waitForIncrementalScanBusy() {
    await this.appBar.waitForPageCondition((selector) => {
      const indicator = document.querySelector(selector);
      return indicator instanceof HTMLElement && indicator.classList.contains('is-busy');
    }, { timeout: 10000 }, this.appBar.scanIndicatorSelector);
  }

  async waitForIncrementalScanComplete(options = {}) {
    const timeout = options.timeout || 120000;
    let lastStatus = null;
    await expect.poll(async () => {
      let response;
      try {
        response = await this.appBar.page.request.get('/status');
      } catch (error) {
        if (!isRetryableStatusProbeError(error)) throw error;
        lastStatus = { transport_error: String(error?.message || error) };
        return true;
      }
      if (!response.ok()) {
        throw new Error(`Status request failed with HTTP ${response.status()}.`);
      }
      lastStatus = await response.json();
      const scanBusy = Boolean(
        lastStatus.scan_in_progress || lastStatus.relations_in_progress
      );
      if (!scanBusy) {
        const scanOutcome = String(lastStatus.scan_outcome || '').trim().toLowerCase();
        const lastError = String(lastStatus.last_error || '').trim();
        if (lastError || scanOutcome === 'failed' || scanOutcome === 'error') {
          throw new Error(
            `Incremental scan failed: ${lastError || `scan outcome was ${scanOutcome}`}.`
          );
        }
      }
      return scanBusy;
    }, {
      message: () => (
        'Expected the production incremental scan and relation projection to complete. '
        + `Last status: ${JSON.stringify(lastStatus)}`
      ),
      timeout,
      intervals: [250, 500, 1000],
    }).toBe(false);
    return lastStatus;
  }

  async triggerIncrementalScanAndWaitForBusy() {
    const refreshResponsePromise = this.appBar.page.waitForResponse((response) => {
      if (response.request().method() !== 'POST') return false;
      return new URL(response.url()).pathname === '/refresh-api';
    });
    await this.triggerIncrementalScan();
    const [refreshResponse] = await Promise.all([
      refreshResponsePromise,
      this.waitForIncrementalScanBusy(),
    ]);
    if (!refreshResponse.ok()) {
      throw new Error(`Incremental scan request failed with HTTP ${refreshResponse.status()}.`);
    }
  }

  async triggerIncrementalScanAndWait(options = {}) {
    await this.triggerIncrementalScanAndWaitForBusy();
    await this.waitForIncrementalScanComplete(options);
  }

  async waitForScanAndCoverRefreshIdle(options = {}) {
    let lastStatus = null;
    await expect.poll(async () => {
      let response;
      try {
        response = await this.appBar.page.request.get('/status');
      } catch (error) {
        if (!isRetryableStatusProbeError(error)) throw error;
        lastStatus = { transport_error: String(error?.message || error) };
        return true;
      }
      if (!response.ok()) {
        throw new Error(`Status request failed with HTTP ${response.status()}.`);
      }
      lastStatus = await response.json();
      return Boolean(lastStatus.scan_in_progress || lastStatus.covers_in_progress);
    }, {
      message: () => (
        'Expected the production scan and automatic cover refresh to become idle. '
        + `Last status: ${JSON.stringify(lastStatus)}`
      ),
      timeout: options.timeout || 120000,
      intervals: [500, 1000, 2000],
    }).toBe(false);
    return lastStatus;
  }

  async triggerFullRescanAndWait(options = {}) {
    await this.triggerFullRescanAndWaitForBusy();
    if (typeof options.onScanBusy === 'function') {
      await options.onScanBusy();
    }
    await this.waitForIncrementalScanComplete(options);
  }

  async triggerFullRescanAndWaitForBusy() {
    const refreshResponsePromise = this.appBar.page.waitForResponse((response) => {
      if (response.request().method() !== 'POST') return false;
      if (new URL(response.url()).pathname !== '/refresh-api') return false;
      return response.request().postDataJSON()?.full_rescan === true;
    });
    await this.triggerFullRescan();
    const [refreshResponse] = await Promise.all([
      refreshResponsePromise,
      this.waitForIncrementalScanBusy(),
    ]);
    if (!refreshResponse.ok()) {
      throw new Error(`Full rescan request failed with HTTP ${refreshResponse.status()}.`);
    }
  }

  async dismissStatusMenu() {
    await this.appBar.page.keyboard.press('Escape');
    await expect(this.appBar.statusContextMenu).toBeHidden();
  }

  async readIncrementalScanBusyState() {
    const className = String(await this.appBar.scanIndicator.getAttribute('class') || '');
    return className.split(/\s+/).includes('is-busy');
  }

  async goToScanPage(options = {}) {
    if (!options.menuAlreadyOpen) await this.openStatusMenu();
    await this.appBar.scanActionButton.click();
  }

  async readStatusTitle() {
    return this.appBar.scanIndicator.getAttribute('title');
  }
}
