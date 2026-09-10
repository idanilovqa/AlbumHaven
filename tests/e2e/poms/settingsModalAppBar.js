import { BasePage } from './basePage.js';

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
