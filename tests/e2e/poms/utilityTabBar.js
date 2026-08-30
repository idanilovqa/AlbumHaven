import { BasePage } from './basePage.js';

export class UtilityTabBar extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.tabs = page.locator('[data-utility-tab]');
    this.activeTab = page.locator(this.activeTabSelector);
  }

  tabByKey(tabKey) {
    return this.page.locator(`[data-utility-tab="${tabKey}"]`).first();
  }

  get activeTabSelector() {
    return '[data-utility-tab][aria-selected="true"]';
  }
}
