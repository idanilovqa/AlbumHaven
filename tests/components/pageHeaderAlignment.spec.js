const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (11-08): every page header places its title and subtitle like the Gallery header. Admin and settings
// pages may add Back before the title, but the subtitle sits as close under the title, at the same sizes.
const root = path.join(__dirname, '..', '..');
const backIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" aria-hidden="true"><path d="m10 5-7 7 7 7M3 12h18"/></svg>';
// Markup mirrors partials/gallery-bar.html (gallery_context and page_gallery_bar variants).
const markup = `
  <main class="shell-main-surface" style="display:block">
    <header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary">
      <div class="gallery-bar__context"><div class="gallery-bar__title"><button class="action-button mobile-bar-action" id="mobile-library-button" aria-label="Open library navigation"></button><span data-gallery-context-name>Gallery</span></div><span class="gallery-bar__summary" data-gallery-context-summary>6105 artists · 14755 albums</span></div>
      <div class="gallery-bar__actions"><button class="gallery-action-button" aria-label="View">V</button></div>
    </header>
    <header class="gallery-bar page-gallery-bar" data-gallery-bar data-gallery-bar-instance="page" data-gallery-bar-layout="mobile-primary">
      <a data-settings-parent class="action-button action-button--bare page-gallery-bar__back" href="/" aria-label="Back to library">${backIcon}</a>
      <div class="gallery-bar__context"><h1 class="gallery-bar__title">Users &amp; access</h1><p class="gallery-bar__summary">Local Library</p></div>
      <div class="gallery-bar__actions"><button class="action-button" aria-label="Invite">+</button></div>
    </header>
    <header class="gallery-bar page-gallery-bar" data-gallery-bar data-gallery-bar-instance="page" data-gallery-bar-layout="mobile-primary">
      <div class="gallery-bar__context"><h1 class="gallery-bar__title">Settings</h1><p class="gallery-bar__summary">Your account</p></div>
      <div class="gallery-bar__actions"></div>
    </header>
  </main>`;

async function measure(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('header.gallery-bar'), (header) => {
    const title = header.querySelector('.gallery-bar__title');
    const text = title.querySelector('[data-gallery-context-name]') || title;
    const summary = header.querySelector('.gallery-bar__summary');
    const range = document.createRange();
    const textBox = (node) => { range.selectNodeContents(node); return range.getBoundingClientRect(); };
    const titleText = textBox(text);
    const summaryText = textBox(summary);
    return {
      gap: Math.round(summaryText.top - titleText.bottom),
      titleSize: getComputedStyle(text).fontSize,
      summarySize: getComputedStyle(summary).fontSize,
      textLeftAligned: Math.abs(summaryText.left - titleText.left) <= 1,
    };
  }));
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 700 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`page headers place the subtitle under the title like the Gallery header (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.setContent(`<!doctype html><html><body>${markup}</body></html>`);
    for (const file of ['base.css', 'app-chrome.css', 'button-component.css', 'gallery-main.css', 'mobile-layout.css']) {
      await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
    }
    const [gallery, ...pages] = await measure(page);
    for (const header of pages) {
      expect(header.titleSize).toBe(gallery.titleSize);
      expect(header.summarySize).toBe(gallery.summarySize);
      expect(Math.abs(header.gap - gallery.gap), JSON.stringify({ gallery, header })).toBeLessThanOrEqual(1);
      expect(header.textLeftAligned).toBe(true);
    }
  });
}
