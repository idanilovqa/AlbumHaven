const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Owner (ARTIST-HEADER-LABELS, BUGFIX-17, 2026-11-24): the phone artist header is exactly two lines. Line one: the
// name, the "i" and the country, centred on one line, the country never cut. Line two: the album count directly
// under the name, a fat dot and only the top genre, the genre never cut. Controls move to line two before the
// name is ellipsized.
const root = path.join(__dirname, '..', '..');
const runtime = path.join(root, 'music_app/static/js/runtime');
const read = (file) => fs.readFileSync(path.join(runtime, file), 'utf8');
const slice = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
};
const interactions = read('gallery-main-interactions.js');
const SCRIPTS = [
  slice(read('markup-format-helpers.js'), 'escapeHtml'),
  read('gallery-main-components.js'),
  slice(interactions, 'renderGalleryMainContext'),
  slice(interactions, 'syncGalleryBarNameFit'),
  'function positionGalleryFamilyPanel() {}',
];
const STYLES = ['appearance-backgrounds.css', 'button-component.css', 'runtime/base-layout.css', 'runtime/utilities.css',
  'runtime/non-album-and-player.css', 'app-chrome.css', 'gallery-main.css', 'mobile-layout.css'];
const ARTISTS = {
  short: { artist: 'Mastodon', albumCount: 9, artist_musicbrainz: { country: 'US', genres: ['Progressive Metal', 'sludge metal', 'stoner metal'] } },
  long: { artist: 'Godspeed You! Black Emperor', albumCount: 12, artist_musicbrainz: { country: 'CA', genres: ['Post-Rock', 'drone', 'experimental'] } },
};

// The Gallery instance of partials/gallery-bar.html, filled the way the artist page fills it.
async function header(page, { width, buttons, artist, addLater = 0 }) {
  await page.setViewportSize({ width, height: 700 });
  await page.setContent('<!doctype html><html data-client-profile="mobile"><body><div class="shell-layout"><main id="shell-main-surface" class="shell-main-surface"></main></div></body></html>');
  for (const file of STYLES) await page.addStyleTag({ path: path.join(root, 'music_app/static/css', file) });
  for (const content of SCRIPTS) await page.addScriptTag({ content });
  return page.evaluate(async ({ context, buttons: total, addLater: extra }) => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.getElementById('shell-main-surface').innerHTML = `<header class="gallery-bar" data-gallery-bar data-gallery-bar-instance="gallery" data-gallery-bar-layout="mobile-primary" aria-label="Gallery controls">
      <button type="button" class="button ui-button ui-button--icon ui-button--medium action-button action-button--bare mobile-bar-action" id="mobile-library-button" aria-label="Open library navigation"><span class="ui-button__content action-button__content"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></span></button>
      ${buildGalleryBarHtml({ contextKind: 'artist', ...context })}</header>`;
    const bar = document.querySelector('[data-gallery-bar]');
    const actions = bar.querySelector('.gallery-bar__actions');
    const button = '<button class="gallery-action-button" type="button" aria-label="Action">A</button>';
    actions.innerHTML = button.repeat(total);
    renderGalleryMainContext(bar, { kind: 'artist', ...context });
    await frames();
    for (let index = 0; index < extra; index += 1) actions.insertAdjacentHTML('beforeend', button);
    await frames();

    const shown = (node) => Boolean(node && !node.closest('[hidden]') && node.getClientRects().length
      && getComputedStyle(node).display !== 'none');
    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, centre: (rect.top + rect.bottom) / 2 };
    };
    const name = bar.querySelector('[data-gallery-context-name]');
    const title = bar.querySelector('.gallery-bar__title');
    const line = bar.querySelector('[data-gallery-context-mobile-summary]');
    const country = [...bar.querySelectorAll('.ui-metadata-pill--country')].filter(shown);
    const genres = [...line.querySelectorAll('.gallery-bar__artist-genre')];
    const genre = genres[0];
    const count = line.querySelector('.gallery-bar__summary-count');
    const buttonsShown = [...actions.children].filter(shown).map(box);
    const actionsLeft = Math.min(...buttonsShown.map((item) => item.left));
    // The top genre's own width, measured whole even when the fit dropped it.
    const genreHidden = genre?.hidden;
    if (genre) genre.hidden = false;
    const genreWidth = genre ? genre.getBoundingClientRect().width : 0;
    const genreBefore = genre ? getComputedStyle(genre, '::before') : null;
    if (genre) genre.hidden = genreHidden;
    const textNodes = [name, bar.querySelector('.gallery-info-button__glyph'), ...country, count, ...(shown(genre) ? [genre] : [])];
    return {
      name: { ...box(name), clipped: name.scrollWidth > name.clientWidth + 1, rects: name.getClientRects().length, text: name.textContent },
      info: shown(bar.querySelector('[data-artist-info-trigger]')) ? box(bar.querySelector('.gallery-info-button__glyph')) : null,
      title: box(title),
      country: country.map((pill) => ({ ...box(pill), text: pill.textContent, cut: pill.scrollWidth > pill.clientWidth + 1
        || pill.getBoundingClientRect().right > pill.parentElement.getBoundingClientRect().right + 0.5 })),
      line: { ...box(line), labels: [...line.querySelectorAll('.ui-metadata-pill')].map((pill) => pill.textContent) },
      count: { ...box(count), text: count.textContent },
      genre: genre ? { ...box(genre), shown: shown(genre), text: genre.textContent, width: genreWidth,
        dot: genreBefore.display !== 'none' && genreBefore.content === '"•"' } : null,
      genreCount: genres.length,
      buttons: buttonsShown,
      actionsLeft,
      lineCentres: [...new Set(textNodes.map((node) => Math.round(box(node).centre)))],
      gap: parseFloat(getComputedStyle(line).columnGap) || 0,
      barRight: box(bar).right,
    };
  }, { context: ARTISTS[artist], buttons, addLater });
}

function expectTwoLines(seen, artist) {
  const context = ARTISTS[artist];
  // Line one: the name, the "i" and the whole country, on one centre line.
  expect(seen.name.rects, 'artist name stays on one line').toBe(1);
  expect(seen.info, 'the "i" is shown').not.toBeNull();
  expect(seen.country.map((pill) => pill.text), 'the country shows once, on line one').toEqual([
    new Intl.DisplayNames(['en'], { type: 'region' }).of(context.artist_musicbrainz.country),
  ]);
  const [country] = seen.country;
  expect(country.cut, 'the country is never cut').toBe(false);
  for (const item of [seen.info, country]) expect(Math.abs(item.centre - seen.name.centre)).toBeLessThanOrEqual(1);
  // Line two: the count directly under the name's start, a fat dot and only the top genre.
  expect(seen.line.labels, 'line two carries only the top genre').toEqual([context.artist_musicbrainz.genres[0]]);
  expect(seen.genreCount).toBe(1);
  expect(seen.count.text).toBe(`${context.albumCount} albums`);
  expect(Math.abs(seen.count.left - seen.name.left), 'the count starts under the name').toBeLessThanOrEqual(1);
  expect(seen.count.top, 'the count sits under the name').toBeGreaterThanOrEqual(seen.name.bottom - 4);
  expect(seen.genre.dot, 'a fat dot separates the count and the genre').toBe(true);
  expect(seen.lineCentres.length, 'exactly two text lines').toBe(2);

  const controlsOnLineOne = seen.buttons.every((button) => button.top < seen.name.bottom);
  const controlsOnLineTwo = seen.buttons.every((button) => Math.abs(button.centre - seen.count.centre) <= 2);
  expect(controlsOnLineOne || controlsOnLineTwo, 'controls share line one or line two, never a third line').toBe(true);
  if (controlsOnLineOne) {
    expect(seen.name.clipped, 'the name is not ellipsized while controls could move to line two').toBe(false);
    expect(country.right, 'the country stops before the controls').toBeLessThanOrEqual(seen.actionsLeft);
  }
  // The count is never cut; the genre shows whenever line two has room for it, and is never cut.
  const lineTwoRight = controlsOnLineTwo ? seen.actionsLeft : seen.line.right;
  expect(seen.count.right, 'the count is never cut').toBeLessThanOrEqual(Math.min(seen.line.right, lineTwoRight) + 0.5);
  const room = lineTwoRight - seen.count.right - seen.gap >= seen.genre.width;
  if (room) expect(seen.genre.shown, 'the top genre shows where there is room').toBe(true);
  if (seen.genre.shown) {
    expect(Math.abs(seen.genre.centre - seen.count.centre)).toBeLessThanOrEqual(1);
    expect(seen.genre.right, 'the top genre is never cut').toBeLessThanOrEqual(Math.min(seen.line.right, lineTwoRight) + 0.5);
  }
  return { controlsOnLineOne, controlsOnLineTwo };
}

for (const width of [320, 360, 390, 412, 430, 600]) {
  for (const buttons of [2, 3, 4]) {
    test(`phone artist header is two lines beside ${buttons} buttons at ${width}px`, async ({ page }) => {
      for (const artist of Object.keys(ARTISTS)) {
        await test.step(artist, async () => expectTwoLines(await header(page, { width, buttons, artist }), artist));
      }
    });
  }
}

test('a long artist name moves the controls to line two before it is ellipsized', async ({ page }) => {
  const seen = await header(page, { width: 390, buttons: 3, artist: 'long' });
  expect(expectTwoLines(seen, 'long').controlsOnLineTwo).toBe(true);
  expect(seen.name.right, 'the name runs past where the controls were').toBeGreaterThan(seen.actionsLeft);
});

test('a button that appears later refits the two lines', async ({ page }) => {
  expectTwoLines(await header(page, { width: 390, buttons: 1, artist: 'short', addLater: 3 }), 'short');
});
