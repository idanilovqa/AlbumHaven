import { BasePage } from './basePage.js';

export class LibraryWatchStatus extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.indicator = page.locator('#scan-indicator');
  }
}
