const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.join(__dirname, '..', '..');
const cssRoot = path.join(root, 'music_app', 'static', 'css');

async function mountHeaders(page, width) {
  const looseHeaderClass = width <= 900
    ? 'gallery-bar page-gallery-bar mobile-page-header'
    : 'non-album-modal-header gallery-bar page-gallery-bar';
  const looseHeaderId = width <= 900 ? 'mobile-page-header' : 'loose';
  const looseHeaderLayout = width <= 900 ? ' data-gallery-bar-layout="mobile-primary"' : '';
  await page.setViewportSize({ width, height: 720 });
  await page.setContent(`
    <main class="shell-main-surface">
      <header id="gallery" class="gallery-bar" data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary">
        <div class="gallery-bar__context">
          <div class="gallery-bar__title"><button id="mobile-library-button" class="action-button mobile-bar-action">Menu</button><span>ДДТ family</span></div>
          <span class="gallery-bar__summary">6 artists · 68 albums</span>
        </div>
      </header>
      <div id="${looseHeaderId}" class="${looseHeaderClass}"${looseHeaderLayout}>
        <button data-mobile-back class="action-button mobile-bar-action page-gallery-bar__back">Back</button>
        <div class="gallery-bar__context"><h1 class="gallery-bar__title">Loose Tracks</h1><p class="gallery-bar__summary">155 tracks · ДДТ and family</p></div>
      </div>
      ${width <= 900 ? '<div id="mobile-page-outlet" data-mobile-page-kind="non-album"></div>' : ''}
    </main>`);
  for (const file of ['base.css', 'app-chrome.css', 'button-component.css', 'gallery-main.css', 'runtime/non-album-and-player.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(cssRoot, file) });
  }
}

async function geometry(page, selector) {
  return page.locator(selector).evaluate((header) => {
    const textBox = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().toJSON();
    };
    const bounds = header.getBoundingClientRect();
    const titleNode = header.querySelector('.gallery-bar__title > span') || header.querySelector('.gallery-bar__title');
    const title = textBox(titleNode);
    const summary = textBox(header.querySelector('.gallery-bar__summary'));
    const leading = header.querySelector('.mobile-bar-action')?.getBoundingClientRect().toJSON() || null;
    return {
      titleTop: Math.round(title.top - bounds.top),
      titleLeft: Math.round(title.left - bounds.left),
      summaryTop: Math.round(summary.top - bounds.top),
      summaryLeft: Math.round(summary.left - bounds.left),
      bottomSpace: Math.round(bounds.bottom - summary.bottom),
      titleCenter: Math.round(title.top - bounds.top + title.height / 2),
      leadingCenter: leading ? Math.round(leading.top - bounds.top + leading.height / 2) : null,
    };
  });
}

test('Loose Tracks header uses Gallery header spacing on desktop', async ({ page }) => {
  await mountHeaders(page, 1280);
  await page.locator('#gallery .mobile-bar-action, #loose .mobile-bar-action').evaluateAll(nodes => nodes.forEach(node => node.remove()));
  const gallery = await geometry(page, '#gallery');
  const loose = await geometry(page, '#loose');
  expect(loose).toEqual(gallery);
});

test('mobile Back occupies the Gallery hamburger slot and aligns to the title line', async ({ page }) => {
  await mountHeaders(page, 390);
  const gallery = await geometry(page, '#gallery');
  const loose = await geometry(page, '#mobile-page-header');
  expect(loose.titleTop).toBe(gallery.titleTop);
  expect(loose.summaryTop).toBe(gallery.summaryTop);
  expect(loose.titleLeft).toBe(gallery.titleLeft);
  expect(loose.summaryLeft).toBe(gallery.summaryLeft);
  expect(loose.bottomSpace).toBe(gallery.bottomSpace);
  expect(loose.leadingCenter).toBe(loose.titleCenter);
});
