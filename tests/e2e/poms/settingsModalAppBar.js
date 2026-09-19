import { BasePage } from './basePage.js';

export function readThemeColorChannels(value) {
  const color = String(value).trim();
  if (/^#[\da-f]{6}$/iu.test(color)) return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  if (/^#[\da-f]{3}$/iu.test(color)) return [...color.slice(1)].map(channel => parseInt(channel + channel, 16));
  const functional = color.match(/^(rgb|rgba|color)\((?:srgb\s+)?([\d.\s,]+)(?:\s*\/\s*[\d.]+)?\)$/u);
  if (functional) return functional[2].trim().split(/[\s,]+/u).slice(0, 3).map(channel => Number(channel) * (functional[1] === 'color' ? 255 : 1));
  const mix = color.match(/^color-mix\(in srgb,\s*(.+)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/u);
  if (mix) {
    const first = readThemeColorChannels(mix[1]), second = readThemeColorChannels(mix[3]), weight = Number(mix[2]) / 100;
    return first.map((channel, index) => channel * weight + second[index] * (1 - weight));
  }
  throw new Error(`Unsupported theme color serialization: ${color}`);
}

export class SettingsModalAppBar extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.settingsButton = page.locator('#settings-button');
    this.toolbarAdminLink = page.locator('.toolbar-right').getByRole('link', { name: 'Admin Panel' });
    this.accountMenu = page.getByRole('menu', { name: 'Account actions' });
    this.settingsMenuItem = this.accountMenu.getByRole('menuitem', { name: 'Settings', exact: true });
    this.adminPanelMenuItem = this.accountMenu.getByRole('menuitem', { name: 'Admin Panel', exact: true });
    this.signOutMenuItem = this.accountMenu.getByRole('menuitem', { name: 'Sign Out', exact: true });
    this.modal = page.locator('#utility-modal');
    this.title = page.locator('#utility-modal-title');
    this.subtitle = page.locator('.utility-modal-subtitle');
    this.closeButton = page.locator('#utility-modal-close');
    this.modalBody = page.locator('.utility-modal-body');
  }

  get modalSelector() {
    return '#utility-modal';
  }

  async readAdminHoverTheme() {
    // FTC-PERMISSIONS-011 protects the approved navy menu; explicit saved row themes override it.
    // parity-check: allow-read-only-measurement-evaluate -- compare approved/saved colors without changing page styles
    const colors = await this.adminPanelMenuItem.evaluate(async element => {
      await Promise.all(element.getAnimations()
        .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map(animation => animation.finished));
      const style = getComputedStyle(element);
      const root = element.ownerDocument.documentElement;
      const themed = root.hasAttribute('data-appearance-palette') || root.hasAttribute('data-appearance-item-hover');
      const expected = themed
        ? style.getPropertyValue('--appearance-item-hover').trim() || style.getPropertyValue('--appearance-hover').trim()
        : '#172d43';
      return { expected, actual: style.backgroundColor };
    });
    return { expected: readThemeColorChannels(colors.expected), actual: readThemeColorChannels(colors.actual) };
  }

  get titleSelector() {
    return '#utility-modal-title';
  }

  get modalBodySelector() {
    return '.utility-modal-body';
  }

  async readStackingCheckpoint(underlyingModal, options = {}) {
    await this.waitForPageCondition((selectors) => {
      const utility = document.querySelector(selectors.modal);
      const dialog = utility?.querySelector(selectors.dialog);
      const bounds = dialog?.getBoundingClientRect();
      if (!utility || utility.hidden || !bounds || bounds.width <= 0 || bounds.height <= 0) return false;
      const topmost = document.elementFromPoint(
        bounds.left + (bounds.width / 2),
        bounds.top + (bounds.height / 2),
      );
      return Boolean(topmost?.closest(selectors.modal));
    }, { timeout: options.timeout || 60000 }, {
      modal: this.modalSelector,
      dialog: '.utility-modal-dialog',
    });
    const utilityHandle = await this.modal.elementHandle();
    const underlyingHandle = await underlyingModal.elementHandle();
    if (!utilityHandle || !underlyingHandle) {
      await utilityHandle?.dispose();
      await underlyingHandle?.dispose();
      throw new Error('Utilities and its underlying modal must both be mounted for stacking inspection.');
    }
    try {
      // parity-check: allow-read-only-measurement-evaluate -- verify real modal layering and hit testing
      return await this.page.evaluate(({ utility, underlying }) => {
        const dialog = utility.querySelector('.utility-modal-dialog') || utility;
        const bounds = dialog.getBoundingClientRect();
        const topmost = document.elementFromPoint(
          bounds.left + (bounds.width / 2),
          bounds.top + (bounds.height / 2),
        );
        return {
          utilityZIndex: Number(getComputedStyle(utility).zIndex) || 0,
          underlyingZIndex: Number(getComputedStyle(underlying).zIndex) || 0,
          utilityOwnsTopElement: Boolean(topmost?.closest('#utility-modal')),
        };
      }, { utility: utilityHandle, underlying: underlyingHandle });
    } finally {
      await utilityHandle.dispose();
      await underlyingHandle.dispose();
    }
  }
}
