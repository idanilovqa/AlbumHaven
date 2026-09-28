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
    try { await session.send('Input.synthesizeScrollGesture', { x, y, yDistance: distance, gestureSourceType: 'touch', speed: 450 }); }
    finally { await session.detach(); }
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
    const before = await this.readScroll(this.artistRail);
    await this.swipeAt(box.x + box.width / 2, box.y + box.height - 45);
    await expect.poll(() => this.readScroll(this.artistRail)).toBeGreaterThan(before);
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
  async expectThumbnailCentered() {
    await expect(this.albumThumbnail).toBeVisible();
    const [image, copy] = await Promise.all([this.albumThumbnail.boundingBox(), this.scrolledCopy.boundingBox()]);
    expect(image.y + image.height / 2).toBeCloseTo(copy.y + copy.height / 2, 0);
  }
  async openLibraryStatus() {
    await this.statusButton.click({ button: 'right' });
    await this.statusPageAction.click();
    await expect(this.statusPageBar).toBeVisible();
    await expect(this.statusBack).toBeVisible();
    await expect(this.statusBack).toHaveCSS('border-top-width', '0px');
  }
}
