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
    const title = await this.galleryTitle.boundingBox();
    expect(button.x).toBeCloseTo(title.x, 0);
    expect(button.y + button.height / 2).toBeCloseTo(title.y + title.height / 2, 0);
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
    expect(actions.y - title.y - title.height).toBeLessThanOrEqual(4);
    expect(summary.y + summary.height / 2).toBeCloseTo(actions.y + actions.height / 2, 0);
    expect(summary.x + summary.width).toBeLessThanOrEqual(actions.x);
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
