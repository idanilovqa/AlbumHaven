import { BasePage } from './basePage.js';

export class UtilitySidebarSection extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.label = page.locator('#utility-sidebar-label');
    this.count = page.locator('#utility-problematic-count');
    this.list = page.locator('#utility-problematic-list');
    this.listItems = page.locator('#utility-problematic-list .utility-list-item');
    this.activeListItem = page.locator('#utility-problematic-list .utility-list-item.is-active');
    this.emptyState = page.locator(this.emptyStateSelector);
  }

  get emptyStateSelector() {
    return '#utility-problematic-list .utility-empty-state';
  }
}
