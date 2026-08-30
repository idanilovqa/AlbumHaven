import { BasePage } from './basePage.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

export class UtilityLogHistoryTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.listItems = page.locator(this.listItemSelector);
    this.activeListItem = page.locator('[data-utility-log-history-id].is-active');
    this.detailFiles = page.locator('.utility-log-history-file');
    this.visibleHistorySurfaces = page.locator('#utility-problematic-list, #utility-problematic-detail');
    this.sourceLabel = page.locator('#utility-problematic-detail').getByText('This browser', { exact: true });
    this.exportButton = page.locator('#utility-problematic-detail [data-export-log-history="1"]');
  }

  get listItemSelector() {
    return '[data-utility-log-history-id]';
  }

  get activeItemSelector() {
    return '[data-utility-log-history-id].is-active';
  }
}
