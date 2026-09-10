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
    this.firstInactiveChip = page.locator(`${this.chipSelector}:not(.active)`).first();
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

  async readAppearanceCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect shared Artist Family palette states
    return this.box.evaluate((box) => {
      const toggle = box.querySelector('#related-toggle');
      const primary = box.querySelector('#related-list [data-related-primary="1"]');
      const firstInactive = [...box.querySelectorAll('#related-list .related-chip')]
        .find((chip) => !chip.classList.contains('active'));
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
