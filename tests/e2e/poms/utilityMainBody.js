import { BasePage } from './basePage.js';

export class UtilityMainBody extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.detail = page.locator('#utility-problematic-detail');
    this.emptyState = page.locator(this.emptyStateSelector);
    this.detailTitle = page.locator('#utility-problematic-detail .utility-detail-title, #utility-problematic-detail .utility-rule-title').first();
    this.detailDescription = page.locator('#utility-problematic-detail .utility-rule-description').first();
    this.ruleTitle = page.locator(this.ruleTitleSelector).first();
    this.detailMetas = page.locator('#utility-problematic-detail .utility-detail-meta');
    this.detailCover = page.locator('#utility-problematic-detail .utility-detail-cover');
    this.sectionToggles = page.locator('#utility-problematic-detail [data-utility-section-toggle]');
  }

  get emptyStateSelector() {
    return '#utility-problematic-detail .utility-empty-state';
  }

  get ruleTitleSelector() {
    return '#utility-problematic-detail .utility-rule-title';
  }

  get ruleDescriptionSelector() {
    return '#utility-problematic-detail .utility-rule-description';
  }
}
