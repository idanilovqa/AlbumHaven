import { expect } from '@playwright/test';

export class UtilityIntegrationsActions {
  constructor(utilityIntegrationsTab) {
    this.utilityIntegrationsTab = utilityIntegrationsTab;
    this.lastfmTimeZoneSaveRequests = [];
    this.lastfmTimeZoneSaveRequestListener = null;
  }

  async waitForReady(options = {}) {
    await this.utilityIntegrationsTab.waitForPageCondition((selectors) => {
      if (typeof state === 'undefined' || state.utility?.activeTab !== 'integrations') return false;
      if (state.utility?.integrationsLoading) return false;
      return Boolean(document.querySelector(selectors.listItemSelector))
        && Boolean(document.querySelector(selectors.ruleTitleSelector));
    }, {
      timeout: options.timeout || 60000,
    }, {
      listItemSelector: this.utilityIntegrationsTab.listItemSelector,
      ruleTitleSelector: this.utilityIntegrationsTab.mainBody.ruleTitleSelector,
    });
  }

  async readSummary() {
    return {
      itemCount: await this.utilityIntegrationsTab.listItems.count(),
      detailTitle: String(await this.utilityIntegrationsTab.mainBody.ruleTitle.textContent() || '').trim(),
      hasLastfmForm: await this.utilityIntegrationsTab.lastfmForm.count() > 0,
      libraryRootInputCount: await this.utilityIntegrationsTab.libraryRootInputs.count(),
    };
  }

  async readBrowserTimeZone() {
    // parity-check: allow-read-only-measurement-evaluate -- browser-reported IANA timezone only
    return this.utilityIntegrationsTab.page.evaluate(() => (
      String(Intl.DateTimeFormat().resolvedOptions().timeZone || '').trim()
    ));
  }

  startLastfmTimeZoneSaveObservation() {
    if (this.lastfmTimeZoneSaveRequestListener) {
      throw new Error('Last.fm timezone save observation is already active.');
    }
    this.lastfmTimeZoneSaveRequests = [];
    this.lastfmTimeZoneSaveRequestListener = (request) => {
      if (
        request.method() !== 'POST'
        || new URL(request.url()).pathname !== '/utilities/integrations/lastfm'
      ) {
        return;
      }
      const payload = request.postDataJSON();
      if (payload?.save_timezone_only !== true) return;
      this.lastfmTimeZoneSaveRequests.push({
        timezone: String(payload.timezone || '').trim(),
        saveTimezoneOnly: true,
      });
    };
    this.utilityIntegrationsTab.page.on(
      'request',
      this.lastfmTimeZoneSaveRequestListener,
    );
  }

  readLastfmTimeZoneSaveRequests() {
    return this.lastfmTimeZoneSaveRequests.map((request) => ({ ...request }));
  }

  stopLastfmTimeZoneSaveObservation() {
    if (!this.lastfmTimeZoneSaveRequestListener) return;
    this.utilityIntegrationsTab.page.off(
      'request',
      this.lastfmTimeZoneSaveRequestListener,
    );
    this.lastfmTimeZoneSaveRequestListener = null;
  }

  async waitForLastfmTimeZone(timezone, options = {}) {
    await expect.poll(() => this.utilityIntegrationsTab.readPersistedLastfmTimeZone(),
      { timeout: options.timeout || 10000 }).toBe(String(timezone));
    await expect(this.utilityIntegrationsTab.lastfmTimeZone).toHaveCount(0);
  }

  async connectLastfm({ username, password }, options = {}) {
    await this.utilityIntegrationsTab.scrobbling.click();
    await this.utilityIntegrationsTab.lastfmUsername.fill(String(username));
    await this.utilityIntegrationsTab.lastfmPassword.fill(String(password));
    const responsePromise = this.utilityIntegrationsTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/integrations/lastfm'
    ));
    await this.utilityIntegrationsTab.lastfmConnectButton.click();
    const response = await responsePromise;
    const payload = await response.json();
    if (!response.ok() || !payload.ok) {
      throw new Error(payload.error || `Last.fm connection failed with HTTP ${response.status()}.`);
    }
    await this.waitForConnectedAs(username, options);
    return payload;
  }

  async ensureLastfmConnected({ username, password }, options = {}) {
    await this.utilityIntegrationsTab.scrobbling.click();
    if (await this.utilityIntegrationsTab.lastfmUsername.isDisabled()) {
      await this.waitForConnectedAs(username, options);
      return false;
    }
    await this.connectLastfm({ username, password }, options);
    return true;
  }

  async submitRejectedLastfmConnection({ username, password }, options = {}) {
    await this.utilityIntegrationsTab.scrobbling.click();
    await this.utilityIntegrationsTab.lastfmUsername.fill(String(username));
    await this.utilityIntegrationsTab.lastfmPassword.fill(String(password));
    const responsePromise = this.utilityIntegrationsTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/integrations/lastfm'
    ));
    await this.utilityIntegrationsTab.lastfmConnectButton.click();
    const response = await responsePromise;
    const payload = await response.json();
    if (response.status() !== 400 || payload.ok !== false) {
      throw new Error(`Expected rejected Last.fm authentication, received HTTP ${response.status()}: ${JSON.stringify(payload)}`);
    }
    await this.utilityIntegrationsTab.waitForVisible(this.utilityIntegrationsTab.errorToasts.last(), {
      timeout: options.timeout || 10000,
    });
    return payload;
  }

  async waitForConnectedAs(username, options = {}) {
    await this.utilityIntegrationsTab.scrobbling.click();
    await expect(this.utilityIntegrationsTab.connectedStatus).toHaveText(/Connected/u, { timeout: options.timeout || 10000 });
    await expect(this.utilityIntegrationsTab.lastfmUsername).toHaveValue(String(username));
    await expect(this.utilityIntegrationsTab.lastfmUsername).toBeDisabled();
  }

  async waitForScrobbledCount(count, options = {}) {
    await this.utilityIntegrationsTab.scrobbling.click();
    await expect(this.utilityIntegrationsTab.lastfmScrobbled).toHaveText(
      `Scrobbled: ${Number(count)}`,
      { timeout: options.timeout || 10000 },
    );
  }

  async waitForLastfmSummary({ scrobbled, pending, lastfmTotal }, options = {}) {
    await this.utilityIntegrationsTab.scrobbling.click();
    const timeout = options.timeout || 10000;
    await expect(this.utilityIntegrationsTab.lastfmScrobbled).toHaveText(
      `Scrobbled: ${Number(scrobbled)}`,
      { timeout },
    );
    await expect(this.utilityIntegrationsTab.lastfmPending).toHaveText(
      `Pending: ${Number(pending)}`,
      { timeout },
    );
    await expect(this.utilityIntegrationsTab.lastfmTotal).toHaveText(
      `LastFM Total: ${lastfmTotal === null ? 'Unavailable' : Number(lastfmTotal)}`,
      { timeout },
    );
  }

  async readLastfmSummary(options = {}) {
    await this.utilityIntegrationsTab.scrobbling.click();
    await expect(this.utilityIntegrationsTab.lastfmTotal).not.toHaveText(
      'LastFM Total: Loading...',
      { timeout: options.timeout || 10000 },
    );
    const readCount = async (locator, label) => {
      const text = String(await locator.textContent() || '').trim();
      const value = text.slice(`${label}:`.length).trim();
      if (value === 'Unavailable') return null;
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Expected a nonnegative ${label} count, received ${JSON.stringify(text)}.`);
      }
      return count;
    };
    return {
      scrobbled: await readCount(this.utilityIntegrationsTab.lastfmScrobbled, 'Scrobbled'),
      pending: await readCount(this.utilityIntegrationsTab.lastfmPending, 'Pending'),
      lastfmTotal: await readCount(this.utilityIntegrationsTab.lastfmTotal, 'LastFM Total'),
      submitEnabled: await this.utilityIntegrationsTab.lastfmSubmitButton.isEnabled(),
    };
  }

  async submitPendingScrobbles() {
    const responsePromise = this.utilityIntegrationsTab.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/utilities/integrations/lastfm/scrobbles/submit'
    ));
    await this.utilityIntegrationsTab.lastfmSubmitButton.click();
    const response = await responsePromise;
    return { response, payload: await response.json() };
  }

  async waitForSubmitError(message, options = {}) {
    const timeout = options.timeout || 10000;
    await expect(this.utilityIntegrationsTab.lastfmSubmitAlert).toBeVisible({ timeout });
    await expect(this.utilityIntegrationsTab.lastfmSubmitAlert).toHaveClass(/is-error/u);
    await expect(this.utilityIntegrationsTab.lastfmSubmitAlertMessage).toHaveText(String(message));
  }

  async readSubmitAlertPlacement() {
    const [alert, viewport] = await Promise.all([
      this.utilityIntegrationsTab.lastfmSubmitAlert.boundingBox(),
      Promise.resolve(this.utilityIntegrationsTab.page.viewportSize()),
    ]);
    if (!alert || !viewport) throw new Error('Expected visible Last.fm submit alert geometry.');
    return {
      rightHalf: alert.x + (alert.width / 2) > viewport.width / 2,
      bottomHalf: alert.y + (alert.height / 2) > viewport.height / 2,
    };
  }
}
