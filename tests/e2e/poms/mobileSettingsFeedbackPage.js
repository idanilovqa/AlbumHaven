import { expect } from '@playwright/test';
import { MobileLoopsPage } from './mobileLoopsPage.js';

export class MobileSettingsFeedbackPage extends MobileLoopsPage {
  constructor(page) {
    super(page);
    this.selectedSubsection = this.subsectionMenu.locator('.is-selected, .is-active, [aria-pressed="true"], [aria-selected="true"]').first();
    this.settingsDrawerBack = this.settingsDrawer.getByRole('button', { name: 'Back to settings', exact: true });
    this.loopCount = this.pageSummary.locator('.mobile-loop-count');
    this.detail = this.root.locator('#utility-problematic-detail');
    this.exportLogs = this.detail.locator('[data-log-history-action="export-current"]');
    this.list = this.root.locator('#utility-problematic-list');
    this.problemTitle = this.detail.locator('.utility-detail-summary .utility-detail-title');
    this.problemCover = this.detail.locator('.utility-detail-cover');
    this.problemCards = this.list.locator('[data-problematic-album-key]');
    this.recentActivity = this.list.locator('[data-utility-log-history-id="recent"]');
    this.filter = this.root.locator('#utility-problem-filter-button');
    this.form = page.locator('#app-form-modal');
    this.formPanel = this.form.locator('.confirm-modal-dialog');
    this.libraryPaths = this.detail.locator('[data-library-root-field="path"]');
    this.libraryAdd = this.detail.locator('[data-add-library-root]');
    this.libraryBrowse = this.detail.locator('[data-browse-library-root]');
    this.libraryDelete = this.detail.locator('[data-remove-library-root]');
    this.librarySave = this.detail.locator('[data-save-library-settings]');
    this.libraryRefresh = this.detail.locator('[data-reload-library-settings]');
  }

  async expectReadable(node) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect rendered ink and its painted ancestor background.
    const paint = await node.evaluate(element => {
      const style = getComputedStyle(element);
      let background = style.backgroundColor, ancestor = element.parentElement;
      while (background === 'rgba(0, 0, 0, 0)' && ancestor) {
        background = getComputedStyle(ancestor).backgroundColor;
        ancestor = ancestor.parentElement;
      }
      return { ink: style.color, background };
    });
    this.expectContrast([paint]);
  }

  async expectLibraryReadOnly() {
    await expect(this.libraryPaths.first()).toBeDisabled();
    for (const controls of [this.libraryAdd, this.libraryBrowse, this.libraryDelete]) {
      expect(await controls.count()).toBeGreaterThan(0);
      for (const control of await controls.all()) await expect(control).toBeDisabled();
    }
    await expect(this.librarySave).toBeDisabled();
    await expect(this.libraryRefresh).toBeEnabled();
    await expect(this.libraryRefresh).toHaveText('Refresh');
  }

  async expectAnchoredSelection(menu, trigger) {
    const selected = await menu.locator('[aria-checked="true"]').boundingBox();
    const anchor = await trigger.boundingBox(), popup = await menu.boundingBox();
    expect(Math.abs(selected.y + selected.height / 2 - anchor.y - anchor.height / 2)).toBeLessThan(2);
    expect(popup.y).toBeGreaterThanOrEqual(0);
    expect(popup.y + popup.height).toBeLessThanOrEqual((await this.player.boundingBox()).y);
  }
}
