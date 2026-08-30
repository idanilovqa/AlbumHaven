export class UtilityTabBarActions {
  constructor(utilityTabBar) {
    this.utilityTabBar = utilityTabBar;
  }

  async openTab(tabKey) {
    const tab = this.utilityTabBar.tabByKey(tabKey);
    await this.utilityTabBar.waitForVisible(tab);
    await tab.click();
    await this.waitForTabActive(tabKey);
  }

  async waitForTabActive(tabKey, options = {}) {
    await this.utilityTabBar.waitForPageCondition((expected) => {
      const activeTab = document.querySelector(expected.activeTabSelector);
      return activeTab?.getAttribute('data-utility-tab') === expected.tabKey;
    }, {
      timeout: options.timeout || 60000,
    }, {
      tabKey,
      activeTabSelector: this.utilityTabBar.activeTabSelector,
    });
  }
}
