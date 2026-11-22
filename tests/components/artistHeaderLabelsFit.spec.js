const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (2026-11-18, 2026-11-22 "labels cut off"): labels stop before the buttons and none is ever cut, also
// when a button appears after the header was first measured.
const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/gallery-main-interactions.js'), 'utf8');
const start = source.indexOf('function syncGalleryBarNameFit(');
const fitSource = source.slice(start, source.indexOf('\n}', start) + 2);

const genres = ['post-rock', 'math rock', 'instrumental']
  .map((genre) => `<span class="gallery-bar__artist-genre"><span class="ui-metadata-pill ui-metadata-pill--genre">${genre}</span></span>`)
  .join('');
const country = '<span class="gallery-bar__artist-country"><span class="ui-metadata-pill ui-metadata-pill--country">United Kingdom</span></span>';
const header = (buttons) => `<main class="shell-main-surface" style="display:block">
  <header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary" data-gallery-context-kind="artist">
    <button class="action-button mobile-bar-action" aria-label="Open library navigation"></button>
    <div class="gallery-bar__context">
      <div class="gallery-bar__title"><span data-gallery-context-name>65days</span><span class="gallery-bar__artist-metadata" data-gallery-context-metadata>${country}</span></div>
      <span class="gallery-bar__artist-mobile-summary" data-gallery-context-mobile-summary><span class="gallery-bar__summary-count">8 albums</span>${country}<span class="gallery-bar__artist-genres">${genres}</span></span>
      <span class="gallery-bar__summary" data-gallery-context-summary><span class="gallery-bar__summary-count">8 albums</span><span class="gallery-bar__artist-genres">${genres}</span></span>
    </div>
    <div class="gallery-bar__actions">${'<button class="gallery-action-button" aria-label="Action">A</button>'.repeat(buttons)}</div>
  </header></main>`;

async function labels(page, { width, buttons, addLater = 0 }) {
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(`<!doctype html><html><body style="margin:0">${header(buttons)}</body></html>`);
  for (const file of ['base.css', 'app-chrome.css', 'button-component.css', 'gallery-main.css', 'mobile-layout.css']) {
    await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  }
  await page.addScriptTag({ content: fitSource });
  return page.evaluate(async (extra) => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bar = document.querySelector('[data-gallery-bar]');
    syncGalleryBarNameFit(bar, bar.querySelector('[data-gallery-context-name]'));
    await frames();
    const actions = bar.querySelector('.gallery-bar__actions');
    for (let index = 0; index < extra; index += 1) actions.append(actions.firstElementChild.cloneNode(true));
    await frames();
    const line = bar.querySelector('[data-gallery-context-mobile-summary]');
    const limit = line.getBoundingClientRect().right;
    const shown = [...line.querySelectorAll('.gallery-bar__summary-count, .gallery-bar__artist-country, .gallery-bar__artist-genre')]
      .filter((node) => node.getClientRects().length);
    return {
      shown: shown.map((node) => node.textContent.trim()),
      cut: shown.filter((node) => node.getBoundingClientRect().right > limit + 1).map((node) => node.textContent.trim()),
    };
  }, addLater);
}

for (const width of [320, 360, 390, 412, 430, 600]) {
  for (const buttons of [2, 3, 4]) {
    test(`no artist label is cut beside ${buttons} buttons at ${width}px`, async ({ page }) => {
      const seen = await labels(page, { width, buttons });
      expect(seen.cut).toEqual([]);
      expect(seen.shown[0]).toBe('8 albums');
    });
  }
}

test('a button that appears after the first measurement refits the labels', async ({ page }) => {
  expect((await labels(page, { width: 430, buttons: 1, addLater: 3 })).cut).toEqual([]);
});

test('every label still shows where there is room', async ({ page }) => {
  expect((await labels(page, { width: 700, buttons: 2 })).shown)
    .toEqual(['8 albums', 'United Kingdom', 'post-rock', 'math rock', 'instrumental']);
});
