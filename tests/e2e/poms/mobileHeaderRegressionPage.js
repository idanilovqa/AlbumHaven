import { expect } from '@playwright/test';
import { MobileHeaderPage } from './mobileHeaderPage.js';

export class MobileHeaderRegressionPage extends MobileHeaderPage {
  async expectHomeGlyphAlignment() {
    const button = await this.libraryButton.boundingBox();
    const bar = await this.mainGalleryBar.boundingBox();
    expect(button.width).toBeGreaterThanOrEqual(40);
    expect(button.height).toBeGreaterThanOrEqual(40);
    expect(button.x).toBeCloseTo(bar.x, 0);
    // parity-check: allow-read-only-measurement-evaluate -- measure visible text/glyph rather than padded hitboxes.
    const glyph = await this.libraryButton.locator('svg path').first().evaluate(node => {
      const style = getComputedStyle(node), transform = node.getScreenCTM();
      const cap = style.strokeLinecap === 'round' || style.strokeLinecap === 'square'
        ? parseFloat(style.strokeWidth) * Math.hypot(transform.a, transform.c) / 2 : 0;
      return node.getBoundingClientRect().left - cap;
    });
    for (const label of [this.recentTab, this.home.getByRole('tab', { name: 'Top tracks', exact: true })]) {
      // parity-check: allow-read-only-measurement-evaluate -- locate the first rendered text range in each tab.
      const left = await label.evaluate(node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        let text;
        while ((text = walker.nextNode())) if (text.textContent.trim()) {
          const range = document.createRange(); range.selectNodeContents(text);
          return range.getBoundingClientRect().left;
        }
        throw new Error('Expected visible tab text');
      });
      expect(Math.abs(glyph - left)).toBeLessThanOrEqual(1);
    }
  }

  async labelGeometry(artist) {
    // parity-check: allow-read-only-measurement-evaluate -- atomically observe virtualized label and clipping viewport.
    return this.page.locator('[data-scroll-artist]').evaluateAll((sections, name) => {
      const section = sections.find(node => node.dataset.scrollArtist === name);
      const label = section?.querySelector('.artist-name');
      const scroll = document.getElementById('albums-scroll');
      if (!label || !scroll) return null;
      const bounds = label.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
      const lines = new Set(), walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) if (text.textContent.trim()) {
        const range = document.createRange(); range.selectNodeContents(text);
        for (const rect of range.getClientRects()) if (rect.height > 0) lines.add(Math.round(rect.top));
      }
      return { top: bounds.top, bottom: bounds.bottom, height: bounds.height,
        lineCount: lines.size, viewportTop: viewport.top,
        viewportHeight: viewport.height, scrollTop: scroll.scrollTop };
    }, artist);
  }

  async wheelAndSettle(delta) {
    const bounds = await this.galleryScroll.boundingBox();
    // parity-check: allow-read-only-measurement-evaluate -- observe native scroll completion without setting scroll offsets.
    const before = await this.galleryScroll.evaluate(node => node.scrollTop);
    await this.page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await this.page.mouse.wheel(0, delta);
    let last = before, stable = 0;
    await expect.poll(async () => {
      // parity-check: allow-read-only-measurement-evaluate -- sample native scrolling stability.
      const value = await this.galleryScroll.evaluate(node => node.scrollTop);
      stable = value !== before && value === last ? stable + 1 : 0;
      last = value;
      return stable;
    }).toBeGreaterThanOrEqual(2);
  }

  async expectLabelBoundary(artist, previousArtist, wrapped, snapshot) {
    let geometry;
    for (let step = 0; step < 150; step++) {
      geometry = await this.labelGeometry(artist);
      if (geometry) break;
      const viewport = await this.galleryScroll.boundingBox();
      await this.wheelAndSettle(Math.round(viewport.height * .7));
    }
    expect(geometry, `Expected virtualized artist separator ${artist}`).not.toBeNull();
    if (wrapped) expect(geometry.lineCount).toBeGreaterThan(1);
    for (let attempt = 0; attempt < 8; attempt++) {
      geometry = await this.labelGeometry(artist);
      if (geometry && geometry.bottom > geometry.viewportTop && geometry.bottom <= geometry.viewportTop + 8) break;
      expect(geometry).not.toBeNull();
      await this.wheelAndSettle(Math.round(geometry.bottom - geometry.viewportTop - 4));
    }
    geometry = await this.labelGeometry(artist);
    expect(geometry.bottom).toBeGreaterThan(geometry.viewportTop);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportTop + 8);
    await expect(this.galleryContextName).toHaveText(previousArtist);
    await snapshot(`sticky-${wrapped ? 'wrapped' : 'plain'}-partial`);
    await this.wheelAndSettle(Math.ceil(geometry.bottom - geometry.viewportTop + 2));
    geometry = await this.labelGeometry(artist);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportTop);
    expect(geometry.bottom).toBeGreaterThanOrEqual(geometry.viewportTop - 8);
    await expect(this.galleryContextName).toHaveText(artist);
    await snapshot(`sticky-${wrapped ? 'wrapped' : 'plain'}-hidden`);
    await this.wheelAndSettle(-Math.ceil(geometry.viewportTop - geometry.bottom + 4));
    geometry = await this.labelGeometry(artist);
    expect(geometry.bottom).toBeGreaterThan(geometry.viewportTop);
    await expect(this.galleryContextName).toHaveText(previousArtist);
    await snapshot(`sticky-${wrapped ? 'wrapped' : 'plain'}-reverse-partial`);
  }
}
