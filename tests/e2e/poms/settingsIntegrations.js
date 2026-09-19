import { expect } from '@playwright/test';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';

export class SettingsIntegrations {
  constructor(page) {
    this.page = page;
    this.detail = page.locator('#utility-problematic-detail');
    this.picker = page.getByRole('dialog', { name: 'Choose library folder', exact: true });
    this.pickerPath = this.picker.locator('#app-form-content > p');
    this.guide = page.getByRole('dialog', { name: 'Foobar2000 setup instructions', exact: true });
    this.watcherWarning = page.locator('#toast-layer .system-warning-notification').filter({ hasText: 'Library watcher needs attention' });
    this.dismissWatcherWarning = this.watcherWarning.getByRole('button', { name: 'Dismiss', exact: true });
    this.save = this.detail.getByRole('button', { name: 'Save library settings', exact: true });
    this.error = this.detail.locator('.library-settings-error');
    this.search = page.locator('#utility-problematic-search');
    this.playbackStatistics = this.detail.getByRole('heading', { name: 'Playback statistics', exact: true });
    this.importButton = this.detail.getByRole('button', { name: 'Import', exact: true });
    this.instructions = this.detail.getByRole('button', { name: 'Read setup instructions', exact: true });
    this.guideButtons = this.guide.getByRole('button');
    this.guideClose = this.guide.getByRole('button', { name: 'Close', exact: true });
  }
  navigation(label) { return this.page.locator('[data-utility-integration-key]').filter({ hasText: new RegExp(`^${label}$`, 'u') }); }
  section(title) { return this.detail.locator('.library-settings-section').filter({ has: this.page.getByRole('heading', { name: title, exact: true }) }); }
  roots(title) { return this.section(title).getByRole('textbox'); }
  async add(title) { await this.section(title).getByRole('button', { name: 'Add path', exact: true }).click(); }
  async removeLast(title) { await this.section(title).getByRole('button', { name: new RegExp(`^Remove ${title} path `, 'u') }).last().click(); }
  async chooseLast(title, folder, cancel = false) {
    await this.section(title).getByRole('button', { name: new RegExp(`^Choose ${title} folder `, 'u') }).last().click();
    await expect(this.picker).toBeVisible();
    await this.picker.getByRole('button', { name: 'settings-root-picker-fixture', exact: true }).click();
    await this.picker.getByRole('button', { name: folder, exact: true }).click();
    const escapedFolder = folder.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    await expect(this.pickerPath).toHaveText(new RegExp(`[\\\\/]${escapedFolder}$`, 'u'));
    await this.picker.getByRole('button', { name: cancel ? 'Cancel' : 'Choose folder', exact: true }).click();
    await expect(this.picker).toBeHidden();
    if (!cancel) await expect(this.roots(title).last()).toHaveValue(new RegExp(`[\\\\/]${escapedFolder}$`, 'u'));
  }
  async acknowledgeUnavailableRootWarning() {
    await expect(this.watcherWarning).toBeVisible();
    await this.dismissWatcherWarning.click();
    await expect(this.watcherWarning).toBeHidden();
  }
  async readWatcherWarningPlacement() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the real alert and Save hit targets without changing application state
    return this.watcherWarning.evaluate(warning => {
      const save = document.querySelector('[data-save-library-settings="1"]');
      const dismiss = warning.querySelector('[data-watcher-dismiss="1"]');
      const alertBox = warning.getBoundingClientRect(), saveBox = save.getBoundingClientRect();
      const ownsCenter = node => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      };
      return {
        separate: alertBox.right <= saveBox.left || alertBox.left >= saveBox.right
          || alertBox.bottom <= saveBox.top || alertBox.top >= saveBox.bottom,
        insideViewport: alertBox.left >= 0 && alertBox.top >= 0 && alertBox.right <= innerWidth && alertBox.bottom <= innerHeight,
        saveOwnsHit: ownsCenter(save), dismissOwnsHit: ownsCenter(dismiss),
      };
    });
  }
  async saveResult() {
    const [response] = await Promise.all([
      this.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/library-settings'),
      this.save.click(),
    ]);
    return { status: response.status(), payload: await response.json() };
  }
  async readSettings() {
    const response = await authenticatedPageGet(this.page, '/library-settings');
    expect(response.ok()).toBe(true);
    return (await response.json()).settings;
  }
  async guideGeometry() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the real reading modal and its sole content scroller
    return this.guide.evaluate(dialog => {
      const box = dialog.getBoundingClientRect();
      const scrolls = Array.from(dialog.querySelectorAll('*')).filter(node => {
        const style = getComputedStyle(node);
        return /auto|scroll/u.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      });
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, scrolls: scrolls.length };
    });
  }
}
