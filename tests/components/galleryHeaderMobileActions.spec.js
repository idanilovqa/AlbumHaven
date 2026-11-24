const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (11-08): on mobile the gallery buttons (Artist Family, View, Album types) sit on the name row when the
// whole name fits there; a longer name is printed in full and the buttons move under it.
const root = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'music_app/static/js/runtime/gallery-main-interactions.js'), 'utf8');
const start = source.indexOf('function syncGalleryBarNameFit(');
const fitSource = source.slice(start, source.indexOf('\n}', start) + 2);

const header = (name, genres) => `<main class="shell-main-surface" style="display:block">
  <header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary" data-gallery-context-kind="artist">
    <button class="action-button mobile-bar-action" id="mobile-library-button" aria-label="Open library navigation"></button>
    <div class="gallery-bar__context"><div class="gallery-bar__title"><span data-gallery-context-name>${name}</span><button class="gallery-info-button" data-artist-info-trigger="1" aria-label="Information"><span class="gallery-info-button__glyph">i</span></button><span class="gallery-bar__artist-metadata" data-gallery-context-metadata><span class="gallery-bar__artist-country"><span class="ui-metadata-pill ui-metadata-pill--country">Russia</span></span></span><span class="gallery-bar__artist-divider gallery-divider__line" hidden></span><span class="gallery-bar__artist-total" hidden></span></div><span class="gallery-bar__artist-mobile-summary"><span class="gallery-bar__summary-count">9 albums</span><span class="gallery-bar__artist-country"><span class="ui-metadata-pill ui-metadata-pill--country">Russia</span></span><span class="gallery-bar__artist-genres">${genres.map((genre) => `<span class="gallery-bar__artist-genre"><span class="ui-metadata-pill ui-metadata-pill--genre">${genre}</span></span>`).join('')}</span></span><span class="gallery-bar__summary" data-gallery-context-summary><span class="gallery-bar__summary-count">9 albums</span><span class="gallery-bar__artist-genres">${genres.map((genre) => `<span class="gallery-bar__artist-genre"><span class="ui-metadata-pill ui-metadata-pill--genre">${genre}</span></span>`).join('')}</span></span></div>
    <div class="gallery-bar__actions"><button class="gallery-action-button" aria-label="Artist family">F</button><button class="gallery-action-button" aria-label="View">V</button><button class="gallery-action-button" aria-label="Album types">T</button></div>
  </header></main>`;

async function mount(page, name, width = 390, genres = ['Rock', 'Pop']) {
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(`<!doctype html><html><body>${header(name, genres)}</body></html>`);
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
    const genres = [...mobileSummary.querySelectorAll('.gallery-bar__artist-genre')];
    const count = mobileSummary.querySelector('.gallery-bar__summary-count');
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
      countCenter: (box(count).top + box(count).bottom) / 2,
      mobileCountryCenter: (box(mobileCountry).top + box(mobileCountry).bottom) / 2,
      labelOrder: [...mobileSummary.querySelectorAll('.gallery-bar__summary-count, .gallery-bar__artist-country, .gallery-bar__artist-genre')].map((node) => node.textContent.trim()),
      genreTops: genres.filter((genre) => !genre.hidden).map((genre) => box(genre).top),
      visibleGenreCount: genres.filter((genre) => !genre.hidden && box(genre).width > 0).length,
      metadataBottom: box(mobileSummary).bottom,
      metadataHeight: box(mobileSummary).height,
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
  expect(Math.abs(layout.mobileCountryCenter - layout.countCenter)).toBeLessThanOrEqual(1);
  expect(layout.genreTops.every((top) => top >= layout.mobileSummaryTop)).toBe(true);
  expect(layout.labelOrder).toEqual(['9 albums', 'Russia', 'Rock', 'Pop']);
});

test('desktop aligns artist, info, and country without a separator dot', async ({ page }) => {
  const layout = await mount(page, 'Neal Morse', 1200);
  expect(Math.abs(layout.infoCenter - layout.nameCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.desktopCountryCenter - layout.nameCenter)).toBeLessThanOrEqual(1);
  expect(layout.desktopCountryDot).toBe('none');
});

test('mobile keeps country then genres on one line when they fit', async ({ page }) => {
  const layout = await mount(page, 'Yes', 390, ['Rock', 'Pop']);
  expect(layout.labelOrder).toEqual(['9 albums', 'Russia', 'Rock', 'Pop']);
  expect(new Set(layout.genreTops).size).toBe(1);
  await expect(page.locator('[data-gallery-bar-instance="gallery"]')).toHaveScreenshot('gallery-header-mobile-labels-one-line.png', { animations: 'disabled' });
});

test('mobile wraps labels to a second line without moving the right-side actions', async ({ page }) => {
  const layout = await mount(page, 'Yes', 320, ['Progressive rock', 'Art rock', 'Symphonic rock']);
  expect(layout.visibleGenreCount).toBe(3);
  expect(new Set(layout.genreTops).size).toBe(2);
  expect(layout.actionsTop).toBeLessThan(layout.mobileSummaryTop);
  expect(layout.metadataBottom).toBeGreaterThan(layout.actionsBottom);
  expect(layout.metadataHeight).toBeLessThanOrEqual(50);
  await expect(page.locator('[data-gallery-bar-instance="gallery"]')).toHaveScreenshot('gallery-header-mobile-labels-two-lines.png', { animations: 'disabled' });
});

test('artist controls move down before a fitting artist name is ellipsized on mobile', async ({ page }) => {
  const layout = await mount(page, 'The Neal Morse Band');
  expect(layout.controlsBelow).toBe(true);
  expect(layout.wrapping).toBe(false);
  expect(layout.nameFull).toBe(true);
  expect(layout.actionsTop).toBeGreaterThanOrEqual(layout.nameBottom - 1);
  expect(layout.mobileSummaryTop).toBeGreaterThanOrEqual(layout.actionsBottom);
});
