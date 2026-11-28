const path = require('node:path');
const { test, expect } = require('@playwright/test');

const staticRoot = path.resolve(__dirname, '../../music_app/static');

// Owner (sandbox2, 11-25): the Hoard / New Arrivals hover markers expand as if lagged, and their background dims to
// grey on hover. Opening and closing must follow the marker's own width from the first frame to the last, and the
// marker keeps its background and source-colored border while hovered.

async function mountGalleryCard(page) {
  await page.setContent(`<!doctype html><html data-appearance-mode="dark" data-library-source-icons="true">
    <body style="margin:20px;--panel:#203040;--text:#fff;--muted:#888;--border:#64748b;--library-source-hoard:#d6a34c;--library-source-arrivals:#58bf88">
    <main class="album-row" style="display:grid;grid-template-columns:240px"></main></body></html>`);
  for (const file of ['runtime/non-album-and-player.css', 'runtime/album-artbox-and-gallery-card.css', 'gallery-main.css', 'button-component.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ content: 'function escapeHtml(value) { return String(value ?? ""); }' });
  for (const file of ['gallery-main-components.js', 'gallery-card-component.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(() => {
    document.querySelector('main').innerHTML = buildGalleryCardHtml({
      identity: 'card', renderKey: 'card', albumKey: 'album', title: 'Album', artist: 'Artist', year: '2026',
      trackCount: 2, lengthDisplay: '4m', displayMode: 'cards', sourceCategories: ['hoard', 'new_arrivals'],
      artboxHtml: '<span class="album-artbox album-artbox--ready" style="display:block;width:240px;height:240px">Art</span>',
    });
  });
  // Hovering the card shows its markers; hovering a marker expands it.
  await page.hover('.album-card .album-card__artbox-trigger');
}

async function mountAlbumArtbox(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(`<!doctype html><html data-appearance-mode="dark"><body style="margin:20px">
    <section id="track-modal"><div id="track-modal-cover" class="track-modal-cover">
    <div class="track-modal-cover-shell" style="position:relative;width:320px;height:320px;background:#345"></div></div></section></body></html>`);
  await page.addStyleTag({ content: ':root { --library-source-hoard: #d6a34c; --library-source-arrivals: #58bf88; }' });
  for (const file of ['runtime/alert-components.css', 'runtime/album-details-components.css', 'runtime/track-modal-and-lightbox.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.addScriptTag({ content: 'function escapeHtml(v){return String(v || "");} function usesMobilePageLayout(){return false;}' });
  for (const file of ['alert-components.js', 'gallery-main-components.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(() => {
    document.querySelector('.track-modal-cover-shell').insertAdjacentHTML('beforeend',
      buildAlbumCoverSourceMarkersHtml({ root_provenance: { categories: ['hoard', 'new_arrivals'] } }));
  });
  await page.hover('.track-modal-cover-shell');
}

const surfaces = {
  'Gallery card': { mount: mountGalleryCard, marker: category => `.gallery-card__source-actions--artwork .gallery-source-action--${category}` },
  'Album Details art': { mount: mountAlbumArtbox, marker: category => `.album-details-source-marker--${category}` },
};

// The marker's width at fixed points of its running transitions, read by pausing them (no wall-clock timing).
async function widthsDuringTransition(page, selector, startTransition) {
  await startTransition();
  return page.evaluate((selector) => {
    const marker = document.querySelector(selector);
    const animations = marker.getAnimations({ subtree: true });
    if (!animations.length) return null;
    // Timed by the width transition itself; a delayed text-wrap step may run on after it.
    const sizing = animations.filter(animation => ['max-width', 'width'].includes(animation.transitionProperty));
    if (!sizing.length) return null;
    const duration = Math.max(...sizing.map(animation => animation.effect.getComputedTiming().endTime));
    animations.forEach(animation => animation.pause());
    const widths = [0.25, 0.5, 0.75].map((fraction) => {
      animations.forEach((animation) => { animation.currentTime = duration * fraction; });
      return marker.getBoundingClientRect().width;
    });
    animations.forEach(animation => animation.finish());
    return widths;
  }, selector);
}

for (const [surface, { mount, marker }] of Object.entries(surfaces)) {
  for (const category of ['hoard', 'new_arrivals']) {
    test(`${surface} ${category} marker widens and narrows smoothly with its own width`, async ({ page }) => {
      await mount(page);
      const selector = marker(category);
      const locator = page.locator(selector);
      await expect(locator).toBeVisible();
      await page.waitForTimeout(400);
      const collapsed = (await locator.boundingBox()).width;

      const opening = await widthsDuringTransition(page, selector, () => locator.hover());
      await page.waitForTimeout(400);
      const expanded = (await locator.boundingBox()).width;
      expect(expanded).toBeGreaterThan(collapsed + 30);
      const closing = await widthsDuringTransition(page, selector, () => page.mouse.move(2, 2));

      const span = expanded - collapsed;
      for (const [name, widths, from, to] of [['opening', opening, collapsed, expanded], ['closing', closing, expanded, collapsed]]) {
        expect(widths, `${name} runs a transition`).not.toBeNull();
        const progress = widths.map(width => (width - from) / (to - from));
        // Every sampled point is part-way, and each later point is further along: no stall, no jump.
        for (const value of progress) {
          expect(value, `${name} progress ${progress.join(', ')} of ${span}px`).toBeGreaterThan(0.05);
          expect(value, `${name} progress ${progress.join(', ')} of ${span}px`).toBeLessThan(0.98);
        }
        expect(progress[1]).toBeGreaterThan(progress[0]);
        expect(progress[2]).toBeGreaterThan(progress[1]);
      }
    });

    test(`${surface} ${category} marker keeps its background and border while hovered`, async ({ page }) => {
      await mount(page);
      const locator = page.locator(marker(category));
      await expect(locator).toBeVisible();
      await page.waitForTimeout(400);
      const colors = () => locator.evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, border: style.borderTopColor };
      });
      const resting = await colors();
      await locator.hover();
      await page.waitForTimeout(400);
      expect(await colors()).toEqual(resting);
    });
  }
}
