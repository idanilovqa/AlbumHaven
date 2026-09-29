import { expect } from '@playwright/test';
import { MobilePolishPage } from './mobilePolishPage.js';

/** Trusted input plus read-only geometry; never substitutes an application response. */
export class MobileTouchFeedbackPage extends MobilePolishPage {
  constructor(page) {
    super(page);
    this.visibleAppBar = page.locator('.app-bar:visible').first();
    this.appearanceFooter = page.locator('#utility-modal-footer');
    this.notificationOpen = page.getByRole('button', { name: 'Cover art lookups', exact: true });
    this.notificationPanel = page.locator('#cover-lookup-drawer');
    this.notificationActions = this.notificationPanel.locator('.cover-lookup-drawer-actions .action-button');
    this.notificationClose = this.notificationPanel.locator('[data-close-cover-lookup-drawer]');
    this.scrolledCopy = page.locator('#mobile-page-header > .gallery-bar__context');
    this.settingsMenu = page.locator('#app-shell [data-account-menu]');
    this.mainSearchClear = page.locator('#search-form [data-search-clear]');
    this.statusButton = page.getByRole('button', { name: 'Library status', exact: true });
    this.statusPageAction = page.locator('[data-status-action="go-to-scan-page"]');
    this.statusPageBar = page.locator('#library-status-gallery-bar');
    this.statusBack = this.statusPageBar.getByRole('button', { name: 'Back to previous library view' });
  }
  async readScroll(region) {
    // parity-check: allow-read-only-measurement-evaluate -- read actual native scroll owners.
    return region.evaluate(node => [node, ...node.querySelectorAll('*')].reduce((total, item) => total + item.scrollTop, 0));
  }
  async readPaint(region) {
    // parity-check: allow-read-only-measurement-evaluate -- compare drawer component theme paint.
    return region.evaluate(node => { const css = getComputedStyle(node); return {
      background: css.backgroundColor, shadow: css.boxShadow, border: css.borderRightWidth,
      radius: css.borderTopRightRadius, color: css.color,
    }; });
  }
  async swipeAt(x, y, distance = -160) {
    const session = await this.page.context().newCDPSession(this.page);
    // Use the same trusted touch sequence as the existing first-swipe Family test.
    // synthesizeScrollGesture did not deliver a scrolling touch on this runner.
    const point = offset => [{ x, y: y + offset, id: 0 }];
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(0) });
      for (let step = 1; step <= 12; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(distance * step / 12) });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
  }
  async expectDrawerAtAppBar(drawer) {
    await expect(drawer).toBeVisible();
    await expect.poll(async () => (await drawer.boundingBox()).y).toBeCloseTo((await this.visibleAppBar.boundingBox()).y + (await this.visibleAppBar.boundingBox()).height, 0);
    const box = await drawer.boundingBox(), player = await this.player.boundingBox();
    expect(box.y + box.height).toBeCloseTo(player.y, 0);
    await expect(drawer).toHaveCSS('border-right-width', '0px');
  }
  async inspectArtistDrawerTouch() {
    await this.scrollRegion('gallery', 420);
    await expect.poll(() => this.readScroll(this.galleryScroll)).toBeGreaterThan(0);
    await this.libraryButton.click();
    await this.expectDrawerAtAppBar(this.artistRail);
    const background = await this.readScroll(this.galleryScroll);
    const box = await this.artistRail.boundingBox();
    await this.swipeAt(box.x + box.width + 25, box.y + 180);
    expect(await this.readScroll(this.galleryScroll)).toBe(background);
    // The production drawer reveals the selected artist on opening. At 650px
    // this can already be the bottom of the list: swipe toward available content.
    // parity-check: allow-read-only-measurement-evaluate -- measure native scroll range.
    const range = await this.artistRail.evaluate(node => [node, ...node.querySelectorAll('*')]
      .reduce((sum, item) => sum + Math.max(0, item.scrollHeight - item.clientHeight), 0));
    const before = await this.readScroll(this.artistRail);
    expect(range).toBeGreaterThan(0);
    const towardTop = before > 0;
    await this.swipeAt(box.x + box.width / 2,
      towardTop ? box.y + 110 : box.y + box.height - 45, towardTop ? 160 : -160);
    await expect.poll(async () => ((await this.readScroll(this.artistRail)) - before)
      * (towardTop ? -1 : 1)).toBeGreaterThan(0);
    expect(await this.readScroll(this.galleryScroll)).toBe(background);
    await expect(this.closeArtistRail).toBeInViewport();
    return this.readPaint(this.artistRail);
  }
  async expectGalleryMeetsPlayer() {
    const content = await this.galleryScroll.boundingBox(), player = await this.player.boundingBox();
    expect(content.y + content.height).toBeCloseTo(player.y, 0);
    await expect(this.player).toHaveCSS('box-shadow', 'none');
  }
  async expectTightAppearanceFooter() {
    await this.expectAppearanceFooterFits();
    await expect(this.appearanceFooter).toHaveCSS('border-top-width', '0px');
    const footer = await this.appearanceFooter.boundingBox(), player = await this.player.boundingBox();
    expect(footer.height).toBeLessThanOrEqual(56);
    expect(footer.y + footer.height).toBeCloseTo(player.y, 0);
    // parity-check: allow-read-only-measurement-evaluate -- selected mode has no prefixed pseudo-glyph.
    for (const control of [this.followAppearance, this.customAppearance]) {
      const prefix = await control.evaluate(node => getComputedStyle(node, '::before').content);
      expect(prefix).not.toContain('✓');
    }
  }
  async expectRatingBesideTitle() {
    const rated = this.galleryCards.filter({ has: this.page.locator('.rating-row:not([data-rating-value="0"])') }).first();
    const title = await rated.locator('.album-title').boundingBox();
    const rating = await rated.locator('.rating-row').boundingBox();
    expect(rating.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(rating.y + rating.height / 2).toBeCloseTo(title.y + title.height / 2, 0);
  }
  async openAlbumTitle(title) {
    await this.galleryCards.getByRole('button', { name: title, exact: true }).click();
    await expect(this.trackTable).toBeVisible();
  }
  async expectGalleryTextColumn(stackedActions) {
    const summary = this.mainGalleryBar.locator('[data-gallery-context-summary]');
    const actions = this.mainGalleryBar.locator(':scope > .gallery-bar__actions');
    await expect(summary).toBeVisible();
    await expect.poll(async () => {
      const [name, counts] = await Promise.all([this.galleryContextName.boundingBox(), summary.boundingBox()]);
      return counts.x - name.x;
    }).toBeCloseTo(0, 0);
    const [name, counts, controls, hamburger, bar] = await Promise.all([
      this.galleryContextName.boundingBox(), summary.boundingBox(), actions.boundingBox(),
      this.libraryButton.boundingBox(), this.mainGalleryBar.boundingBox(),
    ]);
    expect(counts.x).toBeGreaterThanOrEqual(hamburger.x + hamburger.width);
    expect(counts.y).toBeGreaterThanOrEqual(name.y + name.height);
    expect(controls.x + controls.width).toBeCloseTo(bar.x + bar.width, 0);
    // parity-check: allow-read-only-measurement-evaluate -- count text must fit without splitting numbers from their labels.
    const textLines = await summary.evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node);
      return Array.from(range.getClientRects()).length;
    });
    expect(textLines).toBe(1);
    if (stackedActions) {
      expect(controls.y).toBeGreaterThanOrEqual(counts.y + counts.height);
      expect(controls.y - counts.y - counts.height).toBeLessThanOrEqual(4);
    } else {
      expect(controls.y + controls.height / 2).toBeCloseTo(counts.y + counts.height / 2, 0);
      expect(counts.x + counts.width).toBeLessThanOrEqual(controls.x);
    }
    expect(await this.hasNoHorizontalOverflow()).toBe(true);
  }
  async expectThumbnailTopAligned() {
    await expect(this.albumThumbnail).toBeVisible();
    const [image, title, summary] = await Promise.all([
      this.albumThumbnail.boundingBox(), this.pageTitle.boundingBox(), this.pageSummary.boundingBox(),
    ]);
    expect(image.y).toBeCloseTo(title.y, 0);
    expect(summary.y).toBeGreaterThanOrEqual(title.y + title.height);
    expect(summary.y + summary.height).toBeLessThanOrEqual(image.y + image.height);
  }
  async expectSearchCollapsed(query) {
    await expect(this.searchInput).not.toBeVisible();
    await expect(this.searchInput).toHaveValue(query);
    await expect(this.searchButton).toHaveAttribute('aria-expanded', 'false');
    await expect(this.searchButton).toHaveAttribute('data-has-query', String(Boolean(query.trim())));
    if (query.trim()) {
      await expect(this.searchButton).toHaveAttribute('aria-description', 'Search query present');
      // parity-check: allow-read-only-measurement-evaluate -- the query dot must actually be painted, not only marked in state.
      const dot = await this.searchButton.evaluate(node => {
        const css = getComputedStyle(node, '::before');
        return { content: css.content, width: css.width, height: css.height, background: css.backgroundColor };
      });
      expect(dot.content).toBe('""');
      expect(dot.width).toBe('8px'); expect(dot.height).toBe('8px');
      expect(dot.background).not.toBe('rgba(0, 0, 0, 0)');
    } else await expect(this.searchButton).not.toHaveAttribute('aria-description');
  }
  async expectExpandedSearchLeavesSettings() {
    await expect(this.searchInput).toBeVisible();
    await expect(this.settingsButton).toBeVisible();
    await expect(this.settingsButton).toBeEnabled();
    // parity-check: allow-read-only-measurement-evaluate -- measure non-overlap and hit-test the real Settings button after search expands.
    await expect.poll(() => this.searchControl.evaluate(control => {
      const button = document.querySelector('#app-shell [data-account-menu-trigger]');
      const field = control.getBoundingClientRect(), settings = button.getBoundingClientRect();
      return Math.abs(field.right - (settings.left - 8)) < 1
        && Math.abs(settings.right - (window.innerWidth - 12)) < 1
        && button.contains(document.elementFromPoint(settings.x + settings.width / 2, settings.y + settings.height / 2));
    })).toBe(true);
  }
  async openLibraryStatus() {
    // The mobile search replaces app-bar actions while expanded. Collapse it
    // through its existing controls before opening the Library status menu.
    if (await this.searchInput.isVisible()) {
      await this.searchInput.fill('');
      await this.searchButton.click();
      await expect(this.searchInput).not.toBeVisible();
    }
    await this.statusButton.click({ button: 'right' });
    await this.statusPageAction.click();
    await expect(this.statusPageBar).toBeVisible();
    await expect(this.statusBack).toBeVisible();
    await expect(this.statusBack).toHaveCSS('border-top-width', '0px');
  }
}
