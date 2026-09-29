import { expect } from '@playwright/test';
import { MobilePolishPage } from './mobilePolishPage.js';

/** Geometry checks for the shared GalleryBar, through normal mobile navigation. */
export class MobileHeaderPage extends MobilePolishPage {
  constructor(page) {
    super(page);
    this.galleryTitle = this.mainGalleryBar.locator('.gallery-bar__title');
    this.gallerySummary = this.mainGalleryBar.locator('[data-gallery-context-summary]');
    this.galleryActions = this.mainGalleryBar.locator(':scope > .gallery-bar__actions');
  }

  async expectBorderlessNavigation() {
    await expect(this.libraryButton).toHaveCSS('border-top-width', '0px');
    await expect(this.libraryButton).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(this.libraryButton).toHaveCSS('box-shadow', 'none');
    const button = await this.libraryButton.boundingBox();
    const bar = await this.mainGalleryBar.boundingBox();
    const name = await this.galleryContextName.boundingBox();
    // The 40px bare hit area centers on the first text line, without stretching it.
    // parity-check: allow-read-only-measurement-evaluate -- measure the actual title's first line height, including wrapped long names.
    const lineHeight = await this.galleryContextName.evaluate(node => parseFloat(getComputedStyle(node).lineHeight));
    expect(button.x).toBeCloseTo(bar.x, 0);
    expect(name.x).toBeCloseTo(button.x + button.width + 6, 0);
    expect(button.y + button.height / 2).toBeCloseTo(name.y + lineHeight / 2, 0);
    expect(button.width).toBeGreaterThanOrEqual(40);
    expect(button.height).toBeGreaterThanOrEqual(40);
  }

  async expectHomeTabsTogether() {
    await expect(this.recentTab).toHaveAttribute('aria-selected', 'true');
    await expect(this.newsTab).toBeDisabled();
    const recent = await this.recentTab.boundingBox();
    const news = await this.newsTab.boundingBox();
    const bar = await this.mainGalleryBar.boundingBox();
    expect(recent.x).toBeCloseTo(bar.x, 0);
    expect(news.y).toBeCloseTo(recent.y, 0);
    expect(news.x - recent.x - recent.width).toBeGreaterThanOrEqual(12);
    expect(news.x - recent.x - recent.width).toBeLessThanOrEqual(28);
    await this.expectBorderlessNavigation();
  }

  async expectCompactGalleryRows() {
    await expect(this.galleryActions).toBeVisible();
    await expect(this.gallerySummary).toBeVisible();
    const title = await this.galleryTitle.boundingBox();
    const summary = await this.gallerySummary.boundingBox();
    const actions = await this.galleryActions.boundingBox();
    const bar = await this.mainGalleryBar.boundingBox();
    const main = await this.mainSurface.boundingBox();
    expect(actions.y - title.y - title.height).toBeGreaterThanOrEqual(0);
    const name = await this.galleryContextName.boundingBox();
    expect(summary.x).toBeCloseTo(name.x, 0);
    if (this.page.viewportSize().width <= 350) {
      // The owner requested a separate action row on very narrow phones.
      expect(summary.y - title.y - title.height).toBeGreaterThanOrEqual(0);
      expect(summary.y - title.y - title.height).toBeLessThanOrEqual(4);
      expect(actions.y - summary.y - summary.height).toBeGreaterThanOrEqual(0);
      expect(actions.y - summary.y - summary.height).toBeLessThanOrEqual(4);
    } else {
      expect(actions.y - title.y - title.height).toBeLessThanOrEqual(4);
      expect(summary.y - title.y - title.height).toBeLessThanOrEqual(4);
      expect(summary.y).toBeCloseTo(actions.y, 0);
      expect(summary.x + summary.width).toBeLessThanOrEqual(actions.x);
    }
    expect(actions.x + actions.width).toBeCloseTo(bar.x + bar.width, 0);
    expect(bar.y - main.y).toBeLessThanOrEqual(10);
    expect(bar.y + bar.height - actions.y - actions.height).toBeLessThanOrEqual(8);
    expect(bar.x + bar.width).toBeLessThanOrEqual(this.page.viewportSize().width);
    await this.expectBorderlessNavigation();
    // Opening the view selector must not enlarge the compact header's row.
    await this.activeView.click();
    await expect(this.viewCluster).toHaveClass(/is-open/);
    expect((await this.mainGalleryBar.boundingBox()).height).toBeCloseTo(bar.height, 0);
    await this.page.keyboard.press('Escape');
  }
}
