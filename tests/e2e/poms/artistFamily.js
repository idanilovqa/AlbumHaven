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
    this.firstInactiveChip = page.locator(`${this.chipSelector}:not(.is-active)`).first();
    this.chipLabelSelector = 'span:first-child';
    this.chipLabels = this.chips.locator(this.chipLabelSelector);
    this.header = page.locator(`${this.boxSelector} > header`);
    this.combineRow = page.locator(`${this.boxSelector} > .artist-family-panel__combine-row`);
    this.total = page.locator(`${this.boxSelector} [data-gallery-family-panel-total]`);
  }

  get boxSelector() {
    return '#artist-family-panel';
  }

  get toggleSelector() {
    return '[data-gallery-bar-action="artist-family"]';
  }

  get listSelector() {
    return '[data-gallery-family-panel-body]';
  }

  get primaryChipSelector() {
    return '[data-gallery-family-panel-body] [data-gallery-family-artist].is-primary';
  }

  get chipSelector() {
    return '[data-gallery-family-panel-body] [data-gallery-family-artist]';
  }

  chipByName(name) {
    return this.chips.filter({
      has: this.page.locator('span:first-child').filter({ hasText: exactNormalizedText(name) }),
    }).first();
  }

  async readAppearanceCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect shared Artist Family palette states
    return this.box.evaluate((box) => {
      const toggle = document.querySelector('[data-gallery-bar-action="artist-family"]');
      const primary = box.querySelector('[data-gallery-family-artist].is-primary');
      const firstInactive = [...box.querySelectorAll('[data-gallery-family-artist]')]
        .find((chip) => !chip.classList.contains('is-active'));
      const read = (element) => {
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          color: style.color,
        };
      };
      return {
        box: read(box),
        toggle: read(toggle),
        primary: read(primary),
        firstInactive: read(firstInactive),
      };
    });
  }
}
