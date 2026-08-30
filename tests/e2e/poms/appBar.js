import { BasePage } from './basePage.js';

export class AppBar extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.toolbar = page.locator(this.toolbarSelector);
    this.scanIndicator = page.locator(this.scanIndicatorSelector);
    this.statusContextMenu = page.locator(this.statusContextMenuSelector);
    this.scanActionButton = page.locator(this.scanActionButtonSelector);
    this.coverActionButton = page.locator(this.coverActionButtonSelector);
    this.scanAlreadyRunningToast = page.locator(this.scanAlreadyRunningToastSelector);
  }

  get toolbarSelector() {
    return '#search-form';
  }

  get scanIndicatorSelector() {
    return '#scan-indicator';
  }

  get statusContextMenuSelector() {
    return '#status-context-menu';
  }

  get scanActionButtonSelector() {
    return '#status-context-menu [data-status-role="scan-action"]';
  }

  get coverActionButtonSelector() {
    return '#status-context-menu [data-status-role="cover-action"]';
  }

  get scanAlreadyRunningToastSelector() {
    return '#toast-layer .toast';
  }
}
