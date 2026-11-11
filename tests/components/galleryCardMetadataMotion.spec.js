const { test, expect } = require('@playwright/test');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '../..');
const artist = 'Transatlantic with Neal Morse and Mike Portnoy and Roine Stolt and Pete Trewavas';

async function readTextBounds(card, text) {
  return card.evaluate((element, expected) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.indexOf(expected);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + expected.length);
      const bounds = range.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom };
    }
    throw new Error(`Missing visible card text: ${expected}`);
  }, text);
}

for (const width of [320, 390]) {
  test(`mobile Gallery year stays visible and stationary while its artist pans at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.setContent('<!doctype html><html><body><main class="fixture"></main></body></html>');
    for (const file of ['runtime/base-layout.css', 'runtime/running-line.css', 'runtime/non-album-and-player.css', 'gallery-main.css', 'mobile-layout.css']) {
      await page.addStyleTag({ path: path.join(repositoryRoot, 'music_app/static/css', file) });
    }
    await page.addStyleTag({ content: '.fixture { margin: 16px; width: calc((100vw - 44px) / 2); } .fixture > .album-card { width: 100%; }' });
    for (const file of ['markup-format-helpers.js', 'gallery-main-components.js', 'running-line.js', 'compact-player-helpers.js', 'mobile-navigation.js', 'gallery-card-component.js']) {
      await page.addScriptTag({ path: path.join(repositoryRoot, 'music_app/static/js/runtime', file) });
    }
    await page.evaluate(artistName => {
      const root = document.querySelector('.fixture');
      root.innerHTML = buildGalleryCardHtml({
        identity: 'motion-fixture', albumKey: 'motion-fixture', displayMode: 'cards',
        title: 'SMPTe', artist: artistName, year: '2000', trackCount: 5, lengthDisplay: '1h 17m',
      });
      syncGalleryCardMetadataMotion(root);
    }, artist);

    const card = page.locator('.fixture .album-card');
    await expect(card.getByRole('button', { name: 'SMPTe', exact: true })).toBeEnabled();
    await expect(card.locator('.track-count')).toHaveText('5 tracks');
    await expect(card.locator('.album-length')).toHaveText('1h 17m');
    await expect(card.locator('.is-card-text-overflowing')).toHaveCount(1);
    const cardBounds = await card.boundingBox();
    const initialYear = await readTextBounds(card, '2000');
    const initialArtist = await readTextBounds(card, 'Transatlantic');
    expect.soft(initialYear.x).toBeGreaterThanOrEqual(cardBounds.x);
    expect.soft(initialYear.right).toBeLessThanOrEqual(cardBounds.x + cardBounds.width);

    // RunningLine holds 15% of each leg, then moves at a readable 12 px/s.
    await expect.poll(async () => initialArtist.x - (await readTextBounds(card, 'Transatlantic')).x, { timeout: 12000 }).toBeGreaterThan(8);
    const movingYear = await readTextBounds(card, '2000');
    expect(movingYear.x).toBeCloseTo(initialYear.x, 0);
    expect(movingYear.y).toBeCloseTo(initialYear.y, 0);
    expect(movingYear.right).toBeLessThanOrEqual(cardBounds.x + cardBounds.width);
    await expect(card.getByRole('button', { name: 'SMPTe', exact: true })).toBeEnabled();
    await expect(card.locator('.track-count')).toHaveText('5 tracks');
    await expect(card.locator('.album-length')).toHaveText('1h 17m');
  });
}
