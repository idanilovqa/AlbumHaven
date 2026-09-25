import { SettingsModalAppBar } from '../../poms/settingsModalAppBar.js';
import { SettingsModalAppBarActions } from '../../actions/settingsModalAppBarActions.js';

export class CapabilityPage {
  constructor(page) {
    this.page = page;
    this.menu = new SettingsModalAppBar(page);
    this.settings = new SettingsModalAppBarActions(this.menu);
    this.policy = page.locator('#capability-bootstrap');
    this.player = page.locator('.global-player');
    this.notice = page.locator('.capability-section-denied');
  }

  tab(key) {
    return this.page.locator(`[data-utility-tab="${key}"]`);
  }

  async allowedActions() {
    return JSON.parse(await this.policy.textContent()).allowed_actions;
  }

  async openSettings() {
    await this.settings.openSettings();
  }
}
