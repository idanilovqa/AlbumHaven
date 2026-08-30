import { BasePage } from './basePage.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

export class ArtistFamily extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.box = page.locator(this.boxSelector);
    this.toggle = page.locator(this.toggleSelector);
    this.list = page.locator(this.listSelector);
    this.primaryChip = page.locator(this.primaryChipSelector);
    this.chips = page.locator(this.chipSelector);
  }

  get boxSelector() {
    return '#related-box';
  }

  get toggleSelector() {
    return '#related-toggle';
  }

  get listSelector() {
    return '#related-list';
  }

  get primaryChipSelector() {
    return '#related-list [data-related-primary="1"]';
  }

  get chipSelector() {
    return '#related-list .related-chip';
  }

  chipByName(name) {
    return this.chips.filter({ hasText: exactNormalizedText(name) }).first();
  }
}
