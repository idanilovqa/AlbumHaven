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
  <header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary" data-gallery-context-kind="artist">
    <div class="gallery-bar__context"><div class="gallery-bar__title"><button class="action-button mobile-bar-action" id="mobile-library-button" aria-label="Open library navigation"></button><span data-gallery-context-name>${name}</span><button class="gallery-info-button" data-artist-info-trigger="1" aria-label="Information"><span class="gallery-info-button__glyph">i</span></button><span class="gallery-bar__artist-metadata" data-gallery-context-metadata><span class="gallery-bar__artist-country"><span class="ui-metadata-pill ui-metadata-pill--country">Russia</span></span></span><span class="gallery-bar__artist-divider gallery-divider__line" hidden></span><span class="gallery-bar__artist-total" hidden></span></div><span class="gallery-bar__artist-mobile-summary">9 albums<span class="gallery-bar__artist-country"><span class="ui-metadata-pill ui-metadata-pill--country">Russia</span></span></span><span class="gallery-bar__summary" data-gallery-context-summary><span class="gallery-bar__summary-count">9 albums</span><span class="gallery-bar__artist-genres"><span class="gallery-bar__artist-genre"><span class="ui-metadata-pill ui-metadata-pill--genre">Progressive rock</span></span><span class="gallery-bar__artist-genre"><span class="ui-metadata-pill ui-metadata-pill--genre">Art rock</span></span><span class="gallery-bar__artist-genre"><span class="ui-metadata-pill ui-metadata-pill--genre">Symphonic rock</span></span></span></span></div>
    <div class="gallery-bar__actions"><button class="gallery-action-button" aria-label="Artist family">F</button><button class="gallery-action-button" aria-label="View">V</button><button class="gallery-action-button" aria-label="Album types">T</button></div>
  </header></main>`;

async function mount(page, name, width = 390) {
  await page.setViewportSize({ width, height: 844 });
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
    const desktopCountry = bar.querySelector('.gallery-bar__artist-metadata .gallery-bar__artist-country');
    const mobileSummary = bar.querySelector('.gallery-bar__artist-mobile-summary');
    const mobileCountry = mobileSummary.querySelector('.gallery-bar__artist-country');
    const summary = bar.querySelector('.gallery-bar__summary');
    const genres = [...bar.querySelectorAll('.gallery-bar__artist-genre')];
    syncGalleryBarNameFit(bar, name);
    const box = (node) => node.getBoundingClientRect();
    return {
      wrapping: bar.classList.contains('is-name-wrapping'),
      controlsBelow: bar.classList.contains('is-controls-below'),
      nameTop: box(name).top, nameBottom: box(name).bottom,
      actionsTop: box(bar.querySelector('.gallery-bar__actions')).top,
      actionsBottom: box(bar.querySelector('.gallery-bar__actions')).bottom,
      nameRight: box(name).right, actionsLeft: box(bar.querySelector('.gallery-bar__actions')).left,
      nameFull: name.scrollWidth <= name.clientWidth + 1,
      titleGridRow: getComputedStyle(title).gridRowStart,
      titleAlignment: getComputedStyle(title).alignItems,
      nameCenter: (box(name).top + box(name).bottom) / 2,
      infoCenter: (box(info).top + box(info).bottom) / 2,
      desktopCountryCenter: (box(desktopCountry).top + box(desktopCountry).bottom) / 2,
      desktopCountryDot: getComputedStyle(desktopCountry, '::before').content,
      mobileSummaryTop: box(mobileSummary).top,
      mobileSummaryCenter: (box(mobileSummary).top + box(mobileSummary).bottom) / 2,
      mobileCountryCenter: (box(mobileCountry).top + box(mobileCountry).bottom) / 2,
      summaryTop: box(summary).top,
      genreTops: genres.filter((genre) => !genre.hidden).map((genre) => box(genre).top),
      visibleGenreCount: genres.filter((genre) => !genre.hidden).length,
      summaryLeft: box(summary).left,
      nameLeft: box(name).left,
    };
  });
}

test('a short gallery name shares its row with the gallery buttons on mobile', async ({ page }) => {
  const layout = await mount(page, 'Yes');
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
  expect(layout.mobileSummaryTop).toBeGreaterThanOrEqual(layout.nameBottom);
  expect(Math.abs(layout.mobileCountryCenter - layout.mobileSummaryCenter)).toBeLessThanOrEqual(1);
  expect(layout.genreTops.every((top) => top >= layout.mobileSummaryTop)).toBe(true);
  expect(layout.summaryTop).toBeGreaterThan(layout.mobileSummaryTop);
  expect(Math.abs(layout.summaryLeft - layout.nameLeft)).toBeLessThanOrEqual(1);
});

test('desktop aligns artist, info, and country without a separator dot', async ({ page }) => {
  const layout = await mount(page, 'Neal Morse', 1200);
  expect(Math.abs(layout.infoCenter - layout.nameCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.desktopCountryCenter - layout.nameCenter)).toBeLessThanOrEqual(1);
  expect(layout.desktopCountryDot).toBe('none');
});

test('mobile keeps several genres on one third line and drops overflow as whole pills', async ({ page }) => {
  const layout = await mount(page, '65daysofstatic', 320);
  expect(layout.visibleGenreCount).toBeGreaterThan(1);
  expect(new Set(layout.genreTops).size).toBe(1);
});

test('artist controls move down before a fitting artist name is ellipsized on mobile', async ({ page }) => {
  const layout = await mount(page, 'The Neal Morse Band');
  expect(layout.controlsBelow).toBe(true);
  expect(layout.wrapping).toBe(false);
  expect(layout.nameFull).toBe(true);
  expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.nameBottom - 1);
});
