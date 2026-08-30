import { BasePage } from './basePage.js';

export class UtilitySearchSection extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.searchInput = page.locator('#utility-problematic-search');
    this.problemFilterButton = page.locator('#utility-problem-filter-button');
    this.problemFilterMenu = page.locator('#utility-problem-filter-menu');
    this.problemFilterOptions = page.locator('[data-problem-filter-value]');
    this.problemFilterChips = page.locator('#utility-problem-filter-chips');
    this.problemFilterChipButtons = page.locator('#utility-problem-filter-chips [data-remove-problem-filter]');
  }

  filterOptionByValue(problemType) {
    return this.page.locator(`[data-problem-filter-value="${problemType}"]`).first();
  }

  filterChipByValue(problemType) {
    return this.page.locator(this.filterChipSelector(problemType)).first();
  }

  filterChipSelector(problemType) {
    return `[data-remove-problem-filter="${problemType}"]`;
  }
}
