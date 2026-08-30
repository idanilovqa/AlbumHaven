import { expect } from '@playwright/test';

export class SettingsModalAppBarActions {
  constructor(settingsModalAppBar) {
    this.settingsModalAppBar = settingsModalAppBar;
  }

  async prepareToOpenSettings() {
    await this.settingsModalAppBar.settingsButton.click({ trial: true });
  }

  async openSettings() {
    await this.settingsModalAppBar.settingsButton.click();
    await this.waitForOpen();
  }

  async pressSpaceOnFocusedSettingsOpener(options = {}) {
    await this.openSettings();
    await this.settingsModalAppBar.settingsButton.focus();
    await expect(this.settingsModalAppBar.settingsButton).toBeFocused();
    await this.settingsModalAppBar.settingsButton.press('Space');
    await this.waitForOpen(options);
    await options.afterSpace?.();
    await expect(this.settingsModalAppBar.settingsButton).toBeFocused();
  }

  async closeSettings(options = {}) {
    await this.settingsModalAppBar.closeButton.click({ timeout: options.timeout || 30000 });
    await this.waitForClosed(options);
  }

  async pressSpaceOnFocusedSettingsClose(options = {}) {
    await this.waitForOpen(options);
    await this.settingsModalAppBar.closeButton.focus();
    await expect(this.settingsModalAppBar.closeButton).toBeFocused();
    await this.settingsModalAppBar.closeButton.press('Space');
    await this.waitForOpen(options);
    await options.afterSpace?.();
    await expect(this.settingsModalAppBar.closeButton).toBeFocused();
  }

  async waitForOpen(options = {}) {
    await this.settingsModalAppBar.waitForPageCondition((selectors) => {
      const isVisible = (element) => Boolean(element && (
        element.offsetWidth
        || element.offsetHeight
        || element.getClientRects().length
      ));
      return isVisible(document.querySelector(selectors.modal))
        && isVisible(document.querySelector(selectors.title))
        && isVisible(document.querySelector(selectors.body));
    }, { timeout: options.timeout || 60000 }, {
      modal: this.settingsModalAppBar.modalSelector,
      title: this.settingsModalAppBar.titleSelector,
      body: this.settingsModalAppBar.modalBodySelector,
    });
  }

  async waitForClosed(options = {}) {
    await this.settingsModalAppBar.waitForHidden(this.settingsModalAppBar.modal, { timeout: options.timeout || 60000 });
  }
}
