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
    this.chipLabelSelector = '.artist-family-panel__name';
    this.chipLabels = this.chips.locator(this.chipLabelSelector);
    this.header = page.locator(`${this.boxSelector} > header`);
    this.combineRow = page.locator(`${this.boxSelector} > .artist-family-panel__combine-row`);
    this.combineSwitch = this.combineRow.getByRole('switch', { name: 'Combine similar artists' });
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

  get pendingCoverSelector() {
    return 'img[data-gallery-cover-src], img[data-gallery-cover-loading="1"]:not([src])';
  }

  get primaryChipSelector() {
    return '[data-gallery-family-panel-body] [data-gallery-family-artist].is-primary';
  }

  get chipSelector() {
    return '[data-gallery-family-panel-body] [data-gallery-family-artist]';
  }

  chipByName(name) {
    return this.chips.filter({
      has: this.page.locator('.artist-family-panel__name').filter({ hasText: exactNormalizedText(name) }),
    }).first();
  }

  chipCountByName(name) {
    return this.chipByName(name).locator('.artist-family-panel__count');
  }

  async readPanelStructure() {
    // parity-check: allow-read-only-measurement-evaluate -- measure Artist Family geometry and owned descendants
    return this.box.evaluate((panel) => ({
      anchorEnvelope: panel.dataset.anchorEnvelope || '',
      anchorWidth: getComputedStyle(panel).getPropertyValue('--gallery-anchor-width').trim(),
      anchorHeight: getComputedStyle(panel).getPropertyValue('--gallery-anchor-height').trim(),
      title: panel.querySelector('h2').textContent.trim(),
      titleRight: panel.querySelector('h2').getBoundingClientRect().right,
      totalLeft: panel.querySelector('[data-gallery-family-panel-total]').getBoundingClientRect().left,
      totalTop: panel.querySelector('[data-gallery-family-panel-total]').getBoundingClientRect().top,
      titleTop: panel.querySelector('h2').getBoundingClientRect().top,
      width: parseFloat(getComputedStyle(panel).width),
      widthCap: Math.min(390, innerWidth * 0.92),
      labelsEllipsize: [...panel.querySelectorAll('[data-gallery-family-artist] > .artist-family-panel__name')]
        .every((label) => {
          const style = getComputedStyle(label);
          return style.textOverflow === 'ellipsis'
            && style.whiteSpace === 'nowrap'
            && style.overflowX === 'hidden';
        }),
      primaryDividerCount: panel.querySelectorAll('.artist-family-panel__primary-divider').length,
      primaryDividerSeparatesFamily: (() => {
        const primary = panel.querySelector('[data-gallery-family-artist].is-primary');
        const divider = panel.querySelector('.artist-family-panel__primary-divider');
        const firstRelated = panel.querySelector('[data-gallery-family-artist]:not(.is-primary)');
        return Boolean(primary && divider && firstRelated
          && primary.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING
          && divider.compareDocumentPosition(firstRelated) & Node.DOCUMENT_POSITION_FOLLOWING);
      })(),
    }));
  }

  async readChipInteractionState(chip) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect shared filter-pill interaction paint
    return chip.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      labelDecoration: getComputedStyle(
        element.querySelector('.artist-family-panel__name'),
      ).textDecorationLine,
      transitionProperty: getComputedStyle(element).transitionProperty,
      transitionDuration: getComputedStyle(element).transitionDuration,
    }));
  }

  async readCombineInteractionState() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect shared dropdown-row interaction paint
    return this.combineSwitch.evaluate((element) => ({
      backgroundColor: getComputedStyle(element).backgroundColor,
      transitionProperty: getComputedStyle(element).transitionProperty,
      transitionDuration: getComputedStyle(element).transitionDuration,
    }));
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
          ...(element.matches('[data-gallery-family-artist]') ? {
          height: element.getBoundingClientRect().height,
          borderWidth: style.borderTopWidth,
          boxShadow: style.boxShadow,
          markerVisible: getComputedStyle(element.querySelector('.artist-family-panel__marker')).visibility,
          thumbnailWidth: element.querySelector('.artist-family-panel__artwork').getBoundingClientRect().width,
          thumbnailHeight: element.querySelector('.artist-family-panel__artwork').getBoundingClientRect().height,
          badgeWidth: element.querySelector('.artist-family-panel__count').getBoundingClientRect().width,
          badgeHeight: element.querySelector('.artist-family-panel__count').getBoundingClientRect().height,
          badgeBackground: getComputedStyle(element.querySelector('.artist-family-panel__count')).backgroundColor,
          } : {}),
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
