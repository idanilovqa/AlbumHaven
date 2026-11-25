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
    this.problemCount = page.locator('#utility-problematic-count');
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
    await expect(menu.locator('[aria-checked="true"]')).toBeInViewport();
    await expect(trigger).toHaveClass(/trigger-anchor-open/);
    const anchor = await trigger.boundingBox(), popup = await menu.boundingBox();
    const edge = await menu.getAttribute('data-trigger-anchor-edge');
    expect(['top', 'bottom']).toContain(edge);
    const gap = edge === 'bottom' ? anchor.y - popup.y - popup.height : popup.y - anchor.y - anchor.height;
    expect(Math.abs(gap)).toBeLessThan(2);
    expect(popup.y).toBeGreaterThanOrEqual(0);
    expect(popup.y + popup.height).toBeLessThanOrEqual((await this.player.boundingBox()).y);
  }

  problemCardTitle(card) {
    return card.locator('.utility-list-item-title');
  }

  // Scrolls the Problematic Files list with real input (a finger dragged on the touch screen, or the mouse
  // wheel) until its end card is fully on screen, at most a bounded number of times; returns every card
  // key seen on the way and that end card.
  async scrollProblemCards(direction, input) {
    const viewport = this.page.viewportSize();
    const session = input === 'touch' ? await this.page.context().newCDPSession(this.page) : null;
    const edgeCard = () => (direction === 'down' ? this.problemCards.last() : this.problemCards.first());
    const seen = new Set();
    try {
      for (let swipe = 0; swipe < 20; swipe += 1) {
        // parity-check: allow-read-only-measurement-evaluate -- read the mounted card keys after each real scroll input
        const keys = await this.problemCards.evaluateAll(cards => cards.map(card => card.getAttribute('data-problematic-album-key')));
        keys.forEach(key => seen.add(key));
        const box = await edgeCard().boundingBox();
        if (box && box.y >= 0 && box.y + box.height <= viewport.height) break;
        const distance = direction === 'down' ? viewport.height * 0.4 : -viewport.height * 0.4;
        if (session) {
          const x = viewport.width / 2;
          const startY = viewport.height / 2 + distance / 2;
          const point = y => [{ x, y, id: 1 }];
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(startY) });
          // Paced like a finger (one move a frame): unpaced moves are not taken as a drag.
          for (let step = 1; step <= 20; step += 1) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(startY - (distance * step) / 20) });
            await this.page.waitForTimeout(16);
          }
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await this.page.mouse.move(viewport.width / 2, viewport.height / 2);
          await this.page.mouse.wheel(0, distance);
        }
        await this.page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
    } finally {
      await session?.detach();
    }
    return { seen, edgeCard: edgeCard() };
  }

}
