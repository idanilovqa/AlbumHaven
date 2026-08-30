import { BasePage } from './basePage.js';

export class SettingsModalAppBar extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.settingsButton = page.locator('#settings-button');
    this.modal = page.locator('#utility-modal');
    this.title = page.locator('#utility-modal-title');
    this.subtitle = page.locator('.utility-modal-subtitle');
    this.closeButton = page.locator('#utility-modal-close');
    this.modalBody = page.locator('.utility-modal-body');
  }

  get modalSelector() {
    return '#utility-modal';
  }

  get titleSelector() {
    return '#utility-modal-title';
  }

  get modalBodySelector() {
    return '.utility-modal-body';
  }
}
