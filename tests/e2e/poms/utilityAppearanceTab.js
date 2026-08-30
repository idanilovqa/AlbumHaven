import { BasePage } from './basePage.js';
import { UtilityMainBody } from './utilityMainBody.js';
import { UtilitySidebarSection } from './utilitySidebarSection.js';

export class UtilityAppearanceTab extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebar = new UtilitySidebarSection(page, testInfo);
    this.mainBody = new UtilityMainBody(page, testInfo);
    this.listItems = page.locator(this.listItemSelector);
    this.seekbarModeInputs = page.locator(this.seekbarModeSelector);
    this.colorInputs = page.locator('[data-appearance-color]');
  }

  get listItemSelector() {
    return '[data-utility-appearance-key]';
  }

  get seekbarModeSelector() {
    return '[data-appearance-seekbar-mode]';
  }

  seekbarModeInput(mode) {
    return this.page.locator(this.seekbarModeSelectorFor(mode));
  }

  seekbarModeSelectorFor(mode) {
    return `[data-appearance-seekbar-mode="${mode}"]`;
  }
}
