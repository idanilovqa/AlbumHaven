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
    await expect(this.utilityIntegrationsTab.lastfmTimeZone).toBeVisible({
      timeout: options.timeout || 10000,
    });
    await expect(this.utilityIntegrationsTab.lastfmTimeZone).toHaveValue(
      String(timezone),
      { timeout: options.timeout || 10000 },
    );
  }

  async connectLastfm({ username, password }, options = {}) {
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
    if (await this.utilityIntegrationsTab.lastfmUsername.isDisabled()) {
      await this.waitForConnectedAs(username, options);
      return false;
    }
    await this.connectLastfm({ username, password }, options);
    return true;
  }

  async submitRejectedLastfmConnection({ username, password }, options = {}) {
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
    await this.utilityIntegrationsTab.waitForPageCondition((expected) => {
      const title = document.querySelector(expected.titleSelector);
      const usernameInput = document.querySelector(expected.usernameSelector);
      return String(title?.textContent || '').includes(`Connected as ${expected.username}`)
        && usernameInput instanceof HTMLInputElement
        && usernameInput.disabled;
    }, { timeout: options.timeout || 10000 }, {
      titleSelector: this.utilityIntegrationsTab.mainBody.ruleTitleSelector,
      usernameSelector: this.utilityIntegrationsTab.lastfmUsernameSelector,
      username: String(username),
    });
  }

  async waitForScrobbledCount(count, options = {}) {
    const expectedText = `Scrobbled: ${Number(count)}.`;
    await this.utilityIntegrationsTab.waitForPageCondition((expected) => (
      [...document.querySelectorAll(expected.metaSelector)]
        .some((element) => String(element.textContent || '').includes(expected.text))
    ), { timeout: options.timeout || 10000 }, {
      metaSelector: this.utilityIntegrationsTab.lastfmStatusMetaSelector,
      text: expectedText,
    });
  }
}
