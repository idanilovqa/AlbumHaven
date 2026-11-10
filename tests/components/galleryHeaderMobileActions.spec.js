const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (11-08): on mobile the gallery buttons (Artist Family, View, Album types) sit on the name row when the
// whole name fits there; a longer name is printed in full and the buttons move under it.
const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/gallery-main-interactions.js'), 'utf8');
const start = source.indexOf('function syncGalleryBarNameFit(');
const fitSource = source.slice(start, source.indexOf('\n}', start) + 2);

const header = (name) => `<main class="shell-main-surface" style="display:block">
  <header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary">
    <div class="gallery-bar__context"><div class="gallery-bar__title"><button class="action-button mobile-bar-action" id="mobile-library-button" aria-label="Open library navigation"></button><span data-gallery-context-name>${name}</span><button class="gallery-info-button" data-artist-info-trigger="1" aria-label="Information"><span class="gallery-info-button__glyph">i</span></button><span class="gallery-bar__artist-divider gallery-divider__line" hidden></span><span class="gallery-bar__artist-total" hidden></span></div><span class="gallery-bar__summary" data-gallery-context-summary>9 albums</span></div>
    <div class="gallery-bar__actions"><button class="gallery-action-button" aria-label="Artist family">F</button><button class="gallery-action-button" aria-label="View">V</button><button class="gallery-action-button" aria-label="Album types">T</button></div>
  </header></main>`;

async function mount(page, name) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html><html><body>${header(name)}</body></html>`);
  for (const file of ['base.css', 'app-chrome.css', 'button-component.css', 'gallery-main.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  await page.addScriptTag({ content: fitSource });
  return page.evaluate(() => {
    const bar = document.querySelector('[data-gallery-bar-instance="gallery"]');
    const name = bar.querySelector('[data-gallery-context-name]');
    const title = bar.querySelector('.gallery-bar__title');
    const info = bar.querySelector('.gallery-info-button');
    const summary = bar.querySelector('.gallery-bar__summary');
    syncGalleryBarNameFit(bar, name);
    const box = (node) => node.getBoundingClientRect();
    return {
      wrapping: bar.classList.contains('is-name-wrapping'),
      nameTop: box(name).top, nameBottom: box(name).bottom,
      actionsTop: box(bar.querySelector('.gallery-bar__actions')).top,
      actionsBottom: box(bar.querySelector('.gallery-bar__actions')).bottom,
      nameRight: box(name).right, actionsLeft: box(bar.querySelector('.gallery-bar__actions')).left,
      nameFull: name.scrollWidth <= name.clientWidth + 1,
      titleGridRow: getComputedStyle(title).gridRowStart,
      titleAlignment: getComputedStyle(title).alignItems,
      nameCenter: (box(name).top + box(name).bottom) / 2,
      infoCenter: (box(info).top + box(info).bottom) / 2,
      summaryTop: box(summary).top,
      summaryLeft: box(summary).left,
      nameLeft: box(name).left,
    };
  });
}

test('a short gallery name shares its row with the gallery buttons on mobile', async ({ page }) => {
  const layout = await mount(page, 'Dragonland');
  expect(layout.wrapping).toBe(false);
  expect(layout.actionsTop).toBeLessThan(layout.nameBottom);
  expect(layout.actionsLeft).toBeGreaterThanOrEqual(layout.nameRight);
  expect(layout.nameFull).toBe(true);
});

test('an artist takeover keeps the album count below the aligned artist and info button', async ({ page }) => {
  const layout = await mount(page, 'Neal Morse');
  expect(layout.titleGridRow).toBe('1');
  expect(layout.titleAlignment).toBe('center');
  expect(Math.abs(layout.infoCenter - layout.nameCenter)).toBeLessThanOrEqual(1);
  expect(layout.summaryTop).toBeGreaterThanOrEqual(layout.nameBottom);
  expect(Math.abs(layout.summaryLeft - layout.nameLeft)).toBeLessThanOrEqual(1);
});

test('a long gallery name is printed in full above the gallery buttons on mobile', async ({ page }) => {
  const layout = await mount(page, 'The Neal Morse Band and Friends of the Progressive Rock Society');
  expect(layout.wrapping).toBe(true);
  expect(layout.nameFull).toBe(true);
  expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.nameBottom - 1);
});
