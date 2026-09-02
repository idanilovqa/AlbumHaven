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
}
