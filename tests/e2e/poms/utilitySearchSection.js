import { BasePage } from './basePage.js';

export class UtilitySearchSection extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.searchInput = page.locator('#utility-problematic-search');
    this.problemFilterButton = page.locator('#utility-problem-filter-button');
    this.problemFilterMenu = page.locator('#utility-problem-filter-menu');
    this.problemFilterOptions = page.locator('[data-problem-filter-value]');
  }

  filterOptionByValue(problemType) {
    return this.page.locator(`[data-problem-filter-value="${problemType}"]`).first();
  }

  selectedFilterOptionByValue(problemType) {
    return this.page.locator(this.selectedFilterOptionSelector(problemType)).first();
  }

  selectedFilterOptionSelector(problemType) {
    return `[data-problem-filter-value="${problemType}"][aria-selected="true"]`;
  }
}
